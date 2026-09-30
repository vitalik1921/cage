import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DesignIndex, LockedDeclaration, LockLevel } from "./design-model.ts";
import { compareText, type Diagnostic } from "./diagnostic.ts";
import { isText, parseRecordText, readRecordFile } from "./record-file.ts";

/** Relative to the project root. */
export const LOCK_FILE = ".design/design.lock.json";

/** What a locked declaration looked like when it was recorded. */
export interface LockEntry {
  module: string;
  name: string;
  kind: "contract" | "data";
  level: LockLevel;
  members: Record<string, string>;
  /** Invariant id to its text; a contract has them, a data type does not. */
  invariants?: Record<string, string>;
}

const keyOf = ({ module, kind, name }: Pick<LockEntry, "module" | "kind" | "name">) => `${module}\n${kind}\n${name}`;

/** The recorded locks; none when there is no lock file yet. */
export const readLockFile = (root: string) => readRecordFile(root, LOCK_FILE, "lock file", parseLockEntries);

/** The entries of a parsed lock file, or what is wrong with it. */
function parseLockEntries(value: unknown): LockEntry[] | string {
  const isEntry = (item: unknown): item is LockEntry => {
    if (typeof item !== "object" || item === null) return false;
    const { module, name, kind, level, members, invariants } = item as Record<string, unknown>;
    const isTexts = (value: unknown) => typeof value === "object" && value !== null && Object.values(value).every(isText);
    const isKind = kind === "contract" ? isTexts(invariants) : kind === "data" && invariants === undefined;
    return isText(module) && isText(name) && isKind && (level === "final" || level === "extendable") && isTexts(members);
  };
  const { version, locks } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(locks)) return 'expected { "version": 1, "locks": [...] } as written by `design lock`.';
  const broken = locks.findIndex((entry) => !isEntry(entry));
  if (broken !== -1) {
    const name = (locks[broken] as { name?: unknown } | null)?.name;
    // A contract entry without "invariants" is what earlier versions wrote.
    return `entry ${broken + 1}${isText(name) ? ` ("${name}")` : ""} is not as \`design lock\` writes it: a contract has "members" and "invariants", a data type only "members".`;
  }
  return locks;
}

/**
 * The lock file as it is at a Git revision, read through `git` from the
 * repository that holds `root`; none when that revision has no lock file.
 * The revision must exist locally: in CI the branch may need a fetch.
 */
export function readBaseLocks(root: string, ref: string): { entries: LockEntry[]; diagnostics: Diagnostic[] } {
  const failure = (code: "E_ENVIRONMENT" | "E_CONFIG", message: string) => ({
    entries: [],
    diagnostics: [{ code, severity: "error" as const, message, file: LOCK_FILE }],
  });
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  const cannot = `Cannot compare the locks with "${ref}"`;

  const commit = git("rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`);
  if (commit.error) return failure("E_ENVIRONMENT", `${cannot}: git could not be run (${commit.error.message}).`);
  if (commit.status !== 0) {
    const reason = commit.stderr.trim().split("\n")[0] || "it is not a commit of this repository; in CI the branch may need to be fetched first";
    return failure("E_ENVIRONMENT", `${cannot}: ${reason}.`);
  }
  const sha = commit.stdout.trim();
  // Paths are relative to the working directory, so a project inside a larger repository works too.
  const listed = git("ls-tree", "--name-only", sha, "--", `./${LOCK_FILE}`);
  if (listed.status !== 0) return failure("E_ENVIRONMENT", `${cannot}: ${listed.stderr.trim() || "git ls-tree failed"}.`);
  if (listed.stdout.trim() === "") return { entries: [], diagnostics: [] };
  const shown = git("show", `${sha}:./${LOCK_FILE}`);
  if (shown.status !== 0) return failure("E_ENVIRONMENT", `${cannot}: ${shown.stderr.trim() || "git show failed"}.`);
  const parsed = parseRecordText(shown.stdout, parseLockEntries);
  return typeof parsed === "string" ? failure("E_CONFIG", `The lock file of "${ref}" is not usable: ${parsed}`) : { entries: parsed, diagnostics: [] };
}

/**
 * What the locks of another revision require of the lock file as it is
 * now: every lock recorded there is still recorded, unchanged, at a level
 * no looser. This is what makes a lock more than a file anyone can edit:
 * lifting one is a change to that revision, which this check never passes.
 */
export function compareWithBase(base: readonly LockEntry[], current: readonly LockEntry[], ref: string): Diagnostic[] {
  const now = new Map(current.map((entry) => [keyOf(entry), entry]));
  const diagnostics: Diagnostic[] = [];
  for (const entry of base) {
    const subject = subjectOf(entry);
    const problem = (text: string) => diagnostics.push({ code: "E_LOCK_BASE", severity: "error", message: text, file: LOCK_FILE, ...(entry.kind === "contract" ? { contract: entry.name } : {}) });
    const here = now.get(keyOf(entry));
    if (!here) {
      problem(`${subject} of ${entry.module} is locked as \`@${entry.level}\` on ${ref}, but its entry is gone from ${LOCK_FILE}. A lock that ${ref} has is not lifted here.`);
      continue;
    }
    const { changes } = differences(entry, here);
    // From extendable to final is stricter; the other way round lifts part of the lock.
    if (entry.level === "final" && here.level !== "final") changes.unshift(`it is \`@final\` there and \`@${here.level}\` here`);
    if (changes.length > 0) problem(`${subject} of ${entry.module} is locked as \`@${entry.level}\` on ${ref}: ${RULE[entry.level]}.\n${changes.join("\n")}`);
  }
  return diagnostics;
}

export interface LockComparison {
  /** A locked declaration differs from its record, lost its tag, or is gone. */
  violations: Diagnostic[];
  /** A marked declaration, or an addition to an extendable one, that `design lock` has not recorded yet. */
  unrecorded: Diagnostic[];
}

/** What a lock covers: signatures by member, and for a contract the texts of its invariants by id. */
type Locked = Pick<LockEntry, "level" | "members" | "invariants">;

/**
 * How `current` differs from what `recorded` locks. A `@final` declaration
 * must be exactly what was recorded. An `@extendable` one must still have
 * everything that was recorded, unchanged, and may have more named members
 * and more invariants: those are `additions`, not `changes`.
 */
function differences(recorded: Locked, current: Locked): { changes: string[]; additions: string[] } {
  const changes: string[] = [];
  const additions: string[] = [];
  const compare = (was: Record<string, string>, now: Record<string, string>, describe: (key: string) => string, mayAdd: (key: string) => boolean) => {
    for (const [key, text] of Object.entries(was)) {
      if (!Object.hasOwn(now, key)) changes.push(`${describe(key)} was removed; it was: ${text}`);
      else if (now[key] !== text) changes.push(`${describe(key)} changed; it was: ${text}`);
    }
    for (const key of Object.keys(now)) {
      if (Object.hasOwn(was, key)) continue;
      if (recorded.level === "extendable" && mayAdd(key)) additions.push(describe(key));
      else changes.push(`${describe(key)} was added`);
    }
  };
  // More named members is what "extendable" allows. Type parameters, a base type or a call signature change what is already there.
  compare(recorded.members, current.members, describeMember, (member) => !member.startsWith(":"));
  compare(recorded.invariants ?? {}, current.invariants ?? {}, (id) => `invariant \`${id}\``, () => true);
  return { changes, additions };
}

const RULE = { final: "it must not change", extendable: "what it has must not change; only members and invariants may be added" };

/**
 * Compares the designs with the recorded locks. A lock is also broken by
 * taking the tag off or deleting the declaration: what is recorded stays
 * locked until its entry is removed from the lock file by hand.
 */
export function compareLocks(index: DesignIndex, entries: readonly LockEntry[]): LockComparison {
  const violations: Diagnostic[] = [];
  const unrecorded: Diagnostic[] = [];
  const recorded = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const current = new Map(index.locked.map((declaration) => [keyOf(declaration), declaration]));

  for (const declaration of index.locked) {
    const entry = recorded.get(keyOf(declaration));
    const subject = subjectOf(declaration);
    if (!entry) {
      unrecorded.push({
        code: "E_LOCK_MISSING",
        severity: "error",
        message: `${subject} is \`@${declaration.level}\` but is not recorded in ${LOCK_FILE} yet. Run \`design lock\`.`,
        ...declaration.location,
      });
      continue;
    }
    const { changes, additions } = differences(entry, declaration);
    if (entry.level !== declaration.level) changes.unshift(`it is recorded as \`@${entry.level}\` and is now marked \`@${declaration.level}\``);

    if (changes.length > 0) {
      violations.push({
        code: "E_LOCK_VIOLATION",
        severity: "error",
        message: `${subject} is \`@${entry.level}\`: ${RULE[entry.level]}.\n${changes.join("\n")}`,
        ...declaration.location,
        ...(declaration.kind === "contract" ? { contract: declaration.name } : {}),
      });
    } else if (additions.length > 0) {
      unrecorded.push({
        code: "W_LOCK_UNRECORDED",
        severity: "warning",
        message: `${subject} has additions that are not locked yet: ${additions.join(", ")}. Run \`design lock\` to record them.`,
        ...declaration.location,
      });
    }
  }

  for (const entry of entries) {
    if (current.has(keyOf(entry))) continue;
    const declared = entry.kind === "contract" ? index.contracts : index.data;
    const declaration = declared.find((candidate) => candidate.module === entry.module && candidate.name === entry.name);
    violations.push({
      code: "E_LOCK_VIOLATION",
      severity: "error",
      message: declaration
        ? `${subjectOf(entry)} is recorded as \`@${entry.level}\` in ${LOCK_FILE}, but the tag was taken off. A lock is lifted by removing its entry from the lock file.`
        : `${subjectOf(entry)} of ${entry.module} is recorded as \`@${entry.level}\` in ${LOCK_FILE}, but it no longer exists.`,
      ...(declaration ? declaration.location : { file: LOCK_FILE }),
    });
  }
  return { violations, unrecorded };
}

const subjectOf = ({ kind, name }: Pick<LockEntry, "kind" | "name">) => `${kind === "contract" ? "Contract" : "Data type"} "${name}"`;

const UNNAMED: Readonly<Record<string, string>> = {
  ":type": "its type",
  ":call": "its call signature",
  ":construct": "its construct signature",
  ":index": "its index signature",
  ":type-parameters": "its type parameters",
  ":extends": "what it extends",
};
const describeMember = (member: string) => (Object.hasOwn(UNNAMED, member) ? UNNAMED[member] : `\`${member}\``);

/**
 * The lock file after recording what is not recorded yet: declarations newly
 * marked, and the additions to extendable ones. Nothing already recorded is
 * changed. Entries are sorted, so the file does not depend on the order of work.
 */
export function recordLocks(index: DesignIndex, entries: readonly LockEntry[]): { entries: LockEntry[]; recorded: { declaration: LockedDeclaration; status: "recorded" | "extended" | "unchanged" }[] } {
  const next = new Map(entries.map((entry) => [keyOf(entry), entry]));
  const recorded = index.locked.map((declaration) => {
    const { module, name, kind, level, members, invariants } = declaration;
    const entry = next.get(keyOf(declaration));
    if (!entry) {
      next.set(keyOf(declaration), { module, name, kind, level, members, ...(kind === "contract" ? { invariants } : {}) });
      return { declaration, status: "recorded" as const };
    }
    // Only what is new is written: the record of what was already locked stays as it is.
    const added = (was: Record<string, string>, now: Record<string, string>) => Object.fromEntries(Object.entries(now).filter(([key]) => !Object.hasOwn(was, key)));
    const newMembers = added(entry.members, members);
    const newInvariants = added(entry.invariants ?? {}, invariants);
    if (entry.level !== "extendable" || Object.keys({ ...newMembers, ...newInvariants }).length === 0) return { declaration, status: "unchanged" as const };
    next.set(keyOf(declaration), {
      ...entry,
      members: { ...entry.members, ...newMembers },
      ...(kind === "contract" ? { invariants: { ...entry.invariants, ...newInvariants } } : {}),
    });
    return { declaration, status: "extended" as const };
  });
  return { entries: [...next.values()].sort((a, b) => compareText(keyOf(a), keyOf(b))), recorded };
}

export const formatLockFile = (entries: readonly LockEntry[]) => `${JSON.stringify({ version: 1, locks: entries }, null, 2)}\n`;
