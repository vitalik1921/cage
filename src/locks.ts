import fs from "node:fs";
import path from "node:path";
import type { DesignIndex, LockedDeclaration, LockLevel } from "./design-model.ts";
import { compareText, type Diagnostic } from "./diagnostic.ts";
import { stripBom } from "./location.ts";

/** Relative to the project root. */
export const LOCK_FILE = ".design/design.lock.json";

/** What a locked declaration looked like when it was recorded. */
export interface LockEntry {
  module: string;
  name: string;
  kind: "contract" | "data";
  level: LockLevel;
  members: Record<string, string>;
}

const keyOf = ({ module, kind, name }: Pick<LockEntry, "module" | "kind" | "name">) => `${module}\n${kind}\n${name}`;

/** The recorded locks; none when there is no lock file yet. */
export function readLockFile(root: string): { entries: LockEntry[]; diagnostics: Diagnostic[] } {
  const invalid = (message: string): { entries: LockEntry[]; diagnostics: Diagnostic[] } => ({
    entries: [],
    diagnostics: [{ code: "E_CONFIG", severity: "error", message: `The lock file is not usable: ${message}`, file: LOCK_FILE }],
  });
  let text: string;
  try {
    text = stripBom(fs.readFileSync(path.join(root, LOCK_FILE), "utf8"));
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? { entries: [], diagnostics: [] } : invalid((cause as Error).message);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return invalid((cause as Error).message);
  }
  const isText = (item: unknown): item is string => typeof item === "string";
  const isEntry = (item: unknown): item is LockEntry => {
    if (typeof item !== "object" || item === null) return false;
    const { module, name, kind, level, members } = item as Record<string, unknown>;
    const isMembers = typeof members === "object" && members !== null && Object.values(members).every(isText);
    return isText(module) && isText(name) && (kind === "contract" || kind === "data") && (level === "final" || level === "extendable") && isMembers;
  };
  const { version, locks } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(locks) || !locks.every(isEntry)) return invalid('expected { "version": 1, "locks": [...] } as written by `design lock`.');
  return { entries: locks, diagnostics: [] };
}

export interface LockComparison {
  /** A locked declaration differs from its record, lost its tag, or is gone. */
  violations: Diagnostic[];
  /** A marked declaration, or an addition to an extendable one, that `design lock` has not recorded yet. */
  unrecorded: Diagnostic[];
}

/**
 * Compares the designs with the recorded locks. A `@final` declaration must
 * be exactly what was recorded; an `@extendable` one must still have
 * everything that was recorded, unchanged, and may have more named members.
 * A lock is also broken by taking the tag off or deleting the declaration:
 * what is recorded stays locked until its entry is removed from the lock
 * file by hand.
 */
export function compareLocks(index: DesignIndex, entries: readonly LockEntry[]): LockComparison {
  const violations: Diagnostic[] = [];
  const unrecorded: Diagnostic[] = [];
  const recorded = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const current = new Map(index.locked.map((declaration) => [keyOf(declaration), declaration]));

  for (const declaration of index.locked) {
    const entry = recorded.get(keyOf(declaration));
    const subject = `${declaration.kind === "contract" ? "Contract" : "Data type"} "${declaration.name}"`;
    if (!entry) {
      unrecorded.push({
        code: "E_LOCK_MISSING",
        severity: "error",
        message: `${subject} is \`@${declaration.level}\` but is not recorded in ${LOCK_FILE} yet. Run \`design lock\`.`,
        ...declaration.location,
      });
      continue;
    }
    const changes: string[] = [];
    if (entry.level !== declaration.level) changes.push(`it is recorded as \`@${entry.level}\` and is now marked \`@${declaration.level}\``);
    for (const [member, signature] of Object.entries(entry.members)) {
      if (!Object.hasOwn(declaration.members, member)) changes.push(`${describe(member)} was removed; it was: ${signature}`);
      else if (declaration.members[member] !== signature) changes.push(`${describe(member)} changed; it was: ${signature}`);
    }
    const added = Object.keys(declaration.members).filter((member) => !Object.hasOwn(entry.members, member));
    // More named members is what "extendable" allows. Type parameters, a base type or a call signature change what is already there.
    const allowed = entry.level === "extendable" && declaration.level === "extendable" ? added.filter((member) => !member.startsWith(":")) : [];
    for (const member of added) if (!allowed.includes(member)) changes.push(`${describe(member)} was added`);

    if (changes.length > 0) {
      const rule = entry.level === "final" ? "it must not change" : "what it has must not change; only members may be added";
      violations.push({
        code: "E_LOCK_VIOLATION",
        severity: "error",
        message: `${subject} is \`@${entry.level}\`: ${rule}.\n${changes.join("\n")}`,
        ...declaration.location,
        ...(declaration.kind === "contract" ? { contract: declaration.name } : {}),
      });
    } else if (allowed.length > 0) {
      unrecorded.push({
        code: "W_LOCK_UNRECORDED",
        severity: "warning",
        message: `${subject} has additions that are not locked yet: ${allowed.map(describe).join(", ")}. Run \`design lock\` to record them.`,
        ...declaration.location,
      });
    }
  }

  for (const entry of entries) {
    if (current.has(keyOf(entry))) continue;
    const declared = entry.kind === "contract" ? index.contracts : index.data;
    const declaration = declared.find((candidate) => candidate.module === entry.module && candidate.name === entry.name);
    const subject = `${entry.kind === "contract" ? "Contract" : "Data type"} "${entry.name}"`;
    violations.push({
      code: "E_LOCK_VIOLATION",
      severity: "error",
      message: declaration
        ? `${subject} is recorded as \`@${entry.level}\` in ${LOCK_FILE}, but the tag was taken off. A lock is lifted by removing its entry from the lock file.`
        : `${subject} of ${entry.module} is recorded as \`@${entry.level}\` in ${LOCK_FILE}, but it no longer exists.`,
      ...(declaration ? declaration.location : { file: LOCK_FILE }),
    });
  }
  return { violations, unrecorded };
}

const UNNAMED: Readonly<Record<string, string>> = {
  ":type": "its type",
  ":call": "its call signature",
  ":construct": "its construct signature",
  ":index": "its index signature",
  ":type-parameters": "its type parameters",
  ":extends": "what it extends",
};
const describe = (member: string) => (Object.hasOwn(UNNAMED, member) ? UNNAMED[member] : `\`${member}\``);

/**
 * The lock file after recording what is not recorded yet: declarations newly
 * marked, and the additions to extendable ones. Nothing already recorded is
 * changed. Entries are sorted, so the file does not depend on the order of work.
 */
export function recordLocks(index: DesignIndex, entries: readonly LockEntry[]): { entries: LockEntry[]; recorded: { declaration: LockedDeclaration; status: "recorded" | "extended" | "unchanged" }[] } {
  const next = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const recorded = index.locked.map((declaration) => {
    const { module, name, kind, level, members } = declaration;
    const entry = next.get(keyOf(declaration));
    if (!entry) {
      next.set(keyOf(declaration), { module, name, kind, level, members });
      return { declaration, status: "recorded" as const };
    }
    const added = Object.keys(members).filter((member) => !Object.hasOwn(entry.members, member));
    if (entry.level !== "extendable" || added.length === 0) return { declaration, status: "unchanged" as const };
    next.set(keyOf(declaration), { ...entry, members: { ...entry.members, ...Object.fromEntries(added.map((member) => [member, members[member]])) } });
    return { declaration, status: "extended" as const };
  });
  return { entries: [...next.values()].sort((a, b) => compareText(keyOf(a), keyOf(b))), recorded };
}

export const formatLockFile = (entries: readonly LockEntry[]) => `${JSON.stringify({ version: 1, locks: entries }, null, 2)}\n`;
