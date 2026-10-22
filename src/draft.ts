import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { checkDesignPhase } from "./design-phase.ts";
import { compareDiagnostics, hasErrors, isError, type Diagnostic } from "./diagnostic.ts";
import { DESIGN_SUFFIX, discoverDesigns, isDesignInScope, withDesignDocument } from "./discovery.ts";
import { digestOf, draftPathOf, formatDraft, inspectPath, parseDraft, targetPathOf, type ParsedDraft } from "./draft-file.ts";
import { compareLocks, LOCK_FILE, readLockFile } from "./locks.ts";
import { toProjectPath } from "./location.ts";
import { createFileExclusively, FileWriteError, writeRecordFile, type Leftover } from "./record-file.ts";
import { formatDiagnostic, plural } from "./report.ts";
import type { TypeScriptInfo } from "./typescript.ts";

export type DraftAction = "create" | "check" | "activate";

export interface DraftOptions {
  root: string;
  config: Config;
  /** Problems of the configuration: with any, nothing is read or written and only they are reported. */
  problems: readonly Diagnostic[];
}

/** What a candidate check looked at: the designs with the draft in place of its target, and the locks; never code, tests or reviews. */
export interface CandidateValidation {
  mode: "candidate";
  designs: "checked";
  /** Not checked when the designs have errors: a rejected declaration would look like a lifted lock. */
  locks: "checked" | "not-checked";
  implementations: "not-checked";
  tests: "not-checked";
  reviews: "not-checked";
  /** The compiler that checked the designs: the project's TypeScript 5 or 6, or the bundled one. */
  typescript: TypeScriptInfo;
}

/**
 * The report of `cage draft`. `base` is the digest of the design the draft was created from, null for a draft of a
 * new document or when the header could not be read. `validation` is null when no candidate check ran.
 */
export interface DraftReport {
  schemaVersion: 1;
  command: "draft";
  action: DraftAction;
  ok: boolean;
  /** Project-relative POSIX paths. */
  draft: string;
  target: string;
  base: string | null;
  status: "created" | "valid" | "invalid" | "activated" | "refused";
  validation: CandidateValidation | null;
  diagnostics: Diagnostic[];
}

/**
 * A write that failed: what failed, and a temporary file of ours left behind, if any, at its own place. Nothing it
 * names was committed.
 */
function writeFailure(root: string, what: string, cause: unknown, file: string): Diagnostic[] {
  const leftover = cause instanceof FileWriteError ? cause.leftover : undefined;
  return [refusal("E_ENVIRONMENT", `${what}: ${(cause as Error).message}`, file), ...(leftover ? [leftoverDiagnostic(root, leftover)] : [])];
}

/** A temporary file of ours that could not be removed: the write itself stands or failed as the report says. */
const leftoverDiagnostic = (root: string, leftover: Leftover): Diagnostic => refusal("E_ENVIRONMENT", `temporary file not removed: ${leftover.message}`, toProjectPath(root, leftover.file));

const refusal = (code: "E_DRAFT" | "E_DRAFT_CONFLICT" | "E_ENVIRONMENT", message: string, file?: string, line?: number): Diagnostic => ({
  code,
  severity: "error",
  message,
  ...(file === undefined ? {} : { file }),
  ...(line === undefined ? {} : { line, column: 1 }),
});

/**
 * Writes the draft of a design document: a copy of the active document, or a new design when there is none, under a
 * header that names the target and the digest of what it was created from. It never overwrites anything.
 */
export function createDraft(options: DraftOptions, target: string): DraftReport {
  const root = path.resolve(options.root);
  const draft = draftPathOf(target);
  // Created is a fact of the disk: once the draft exists, a later problem (a temporary file left) does not undo it.
  const report = (base: string | null, diagnostics: Diagnostic[], created = false): DraftReport => ({
    schemaVersion: 1,
    command: "draft",
    action: "create",
    ok: !hasErrors(diagnostics),
    draft,
    target,
    base,
    status: created ? "created" : "refused",
    validation: null,
    diagnostics,
  });
  if (options.problems.length > 0) return report(null, [...options.problems]);
  if (!isDesignInScope(target, options.config)) return report(null, [outOfScope(target, options.config)]);

  const targetState = inspectPath(root, target);
  if (typeof targetState === "object") return report(null, [refusal("E_DRAFT", targetState.problem, target)]);
  const draftState = inspectPath(root, draft);
  if (typeof draftState === "object") return report(null, [refusal("E_DRAFT", draftState.problem, draft)]);
  if (draftState === "file") return report(null, [refusal("E_DRAFT", `${draft} already exists; it is not overwritten`, draft)]);

  let content: string;
  let base: string | null = null;
  try {
    if (targetState === "file") {
      const text = fs.readFileSync(path.join(root, target), "utf8");
      base = digestOf(text);
      content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } else {
      content = scaffold(target);
      fs.mkdirSync(path.dirname(path.join(root, draft)), { recursive: true });
    }
  } catch (cause) {
    return report(base, [refusal("E_ENVIRONMENT", `cannot write the draft: ${(cause as Error).message}`, draft)]);
  }
  let creation: ReturnType<typeof createFileExclusively>;
  try {
    creation = createFileExclusively(path.join(root, draft), formatDraft(target, base, content));
  } catch (cause) {
    return report(base, writeFailure(root, "cannot write the draft", cause, draft));
  }
  const leftovers = creation.leftover ? [leftoverDiagnostic(root, creation.leftover)] : [];
  if (!creation.created) return report(base, [refusal("E_DRAFT", `${draft} already exists; it is not overwritten`, draft), ...leftovers]);
  return report(base, leftovers, true);
}

/** The draft's candidate checked in place of its target; nothing is written. */
export function checkDraft(options: DraftOptions, draft: string): DraftReport {
  const { report } = validate(options, draft, "check");
  return report;
}

/**
 * Makes a draft the active design: only when the candidate is valid, the locks hold and the target is still what the
 * draft was created from (or still absent). Then the content without the header replaces the target and the draft
 * is removed. On any refusal both files stay as they were. Locks and reviews are not recorded.
 */
export function activateDraft(options: DraftOptions, draft: string): DraftReport {
  const root = path.resolve(options.root);
  const { report, parsed, text } = validate(options, draft, "activate");
  const refuse = (...diagnostics: Diagnostic[]): DraftReport => {
    const all = [...report.diagnostics, ...diagnostics].sort(compareDiagnostics);
    return { ...report, ok: false, status: "refused", diagnostics: all };
  };
  if (!report.ok || !parsed || text === undefined) return refuse();

  // What was checked is what is written: the draft and the target are read again right before the write.
  const target = report.target;
  const targetFile = path.join(root, target);
  try {
    if (fs.readFileSync(path.join(root, draft), "utf8") !== text) return refuse(refusal("E_DRAFT_CONFLICT", `${draft} changed while it was checked`, draft));
  } catch (cause) {
    return refuse(refusal("E_ENVIRONMENT", `cannot read the draft: ${(cause as Error).message}`, draft));
  }
  const baseline = compareBaseline(root, target, parsed, draft);
  if (baseline) return refuse(baseline);
  // The write is the commit point: before it a failure refuses with both files as they were, after it the target is
  // the draft's content, and what goes wrong later (a temporary file, the draft left) is reported with that.
  const after: Diagnostic[] = [];
  try {
    if (parsed.base === null) {
      const creation = createFileExclusively(targetFile, parsed.content);
      if (creation.leftover) after.push(leftoverDiagnostic(root, creation.leftover));
      if (!creation.created) return refuse(refusal("E_DRAFT_CONFLICT", `${target} was created while the draft was checked`, draft, BASE_LINE), ...after);
    } else {
      writeRecordFile(targetFile, parsed.content);
    }
  } catch (cause) {
    return refuse(...writeFailure(root, "cannot write the design", cause, target));
  }
  try {
    fs.rmSync(path.join(root, draft));
  } catch (cause) {
    after.push(refusal("E_ENVIRONMENT", `draft not removed after activation: ${(cause as Error).message}`, draft));
  }
  const diagnostics = [...report.diagnostics, ...after].sort(compareDiagnostics);
  return { ...report, ok: !hasErrors(diagnostics), status: "activated", diagnostics };
}

/** The line of the header that holds the base digest. */
const BASE_LINE = 3;

/** Reads the draft, compares the target with its base, and checks the candidate. */
function validate(options: DraftOptions, draft: string, action: "check" | "activate"): { report: DraftReport; parsed?: ParsedDraft; text?: string } {
  const root = path.resolve(options.root);
  const target = targetPathOf(draft);
  const report = (diagnostics: Diagnostic[], parsed?: ParsedDraft, validation: CandidateValidation | null = null): DraftReport => {
    const ok = !hasErrors(diagnostics);
    return {
      schemaVersion: 1,
      command: "draft",
      action,
      ok,
      draft,
      target,
      base: parsed?.base ?? null,
      status: action === "check" ? (ok ? "valid" : "invalid") : ok ? "activated" : "refused",
      validation,
      diagnostics: diagnostics.sort(compareDiagnostics),
    };
  };
  if (options.problems.length > 0) return { report: report([...options.problems]) };

  const draftState = inspectPath(root, draft);
  if (draftState === "missing") return { report: report([refusal("E_DRAFT", `no draft at ${draft}; cage draft create ${target} writes one`, draft)]) };
  if (typeof draftState === "object") return { report: report([refusal("E_DRAFT", draftState.problem, draft)]) };
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, draft), "utf8");
  } catch (cause) {
    return { report: report([refusal("E_ENVIRONMENT", `cannot read the draft: ${(cause as Error).message}`, draft)]) };
  }
  const parsed = parseDraft(text);
  if ("problem" in parsed) return { report: report([refusal("E_DRAFT", parsed.problem, draft, 1)]) };
  if (parsed.target !== target) return { report: report([refusal("E_DRAFT", `the header names ${parsed.target}; a draft at ${draft} is for ${target}`, draft, 2)], parsed) };
  if (!isDesignInScope(target, options.config)) return { report: report([outOfScope(target, options.config, draft)], parsed) };

  const diagnostics: Diagnostic[] = [];
  const baseline = compareBaseline(root, target, parsed, draft);
  if (baseline) diagnostics.push(baseline);
  if (baseline?.code === "E_DRAFT" || baseline?.code === "E_ENVIRONMENT") return { report: report(diagnostics, parsed) };

  const candidate = checkCandidate(root, options.config, target, parsed);
  // A position in the target is a position in the draft, below its header.
  const moved = <T extends { file?: string; line?: number; endLine?: number }>(at: T): T =>
    at.file !== target ? at : { ...at, file: draft, ...(at.line === undefined ? {} : { line: at.line + parsed.headerLines }), ...(at.endLine === undefined ? {} : { endLine: at.endLine + parsed.headerLines }) };
  diagnostics.push(...candidate.diagnostics.map((diagnostic) => ({ ...moved(diagnostic), ...(diagnostic.related ? { related: diagnostic.related.map(moved) } : {}) })));
  return { report: report(diagnostics, parsed, candidate.validation), parsed, text };
}

/** Whether the target is still what the draft was created from; a conflict, or a problem with the path, otherwise. */
function compareBaseline(root: string, target: string, parsed: ParsedDraft, draft: string): Diagnostic | undefined {
  const state = inspectPath(root, target);
  if (typeof state === "object") return refusal("E_DRAFT", state.problem, target);
  if (state === "missing") return parsed.base === null ? undefined : refusal("E_DRAFT_CONFLICT", `${target} was deleted since the draft was created`, draft, BASE_LINE);
  if (parsed.base === null) return refusal("E_DRAFT_CONFLICT", `${target} was created since the draft was`, draft, BASE_LINE);
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, target), "utf8");
  } catch (cause) {
    return refusal("E_ENVIRONMENT", `cannot read the design: ${(cause as Error).message}`, target);
  }
  return digestOf(text) === parsed.base ? undefined : refusal("E_DRAFT_CONFLICT", `${target} changed since the draft was created`, draft, BASE_LINE);
}

/**
 * The design phase with the draft's content in place of the target, in the target's module and under its path, so
 * that imports of the target resolve to the candidate even when the target does not exist yet; then the locks.
 * Every other active design is read as it is. A marked declaration not recorded yet does not block: activation
 * records no lock, and `check` then reports it as `E_LOCK_MISSING` until `cage lock`.
 */
function checkCandidate(root: string, config: Config, target: string, parsed: ParsedDraft): { diagnostics: Diagnostic[]; validation: CandidateValidation } {
  const document = path.join(root, target);
  const designs = withDesignDocument(root, discoverDesigns(root, config), document);
  const result = checkDesignPhase({ root, tsconfig: config.tsconfig, designImportableTypes: config.designImportableTypes, designs, designPatterns: config.designs, documents: new Map([[document, parsed.content]]) });
  const diagnostics = [...result.diagnostics];
  let locks: CandidateValidation["locks"] = "not-checked";
  if (result.index && !hasErrors(diagnostics)) {
    const lockFile = readLockFile(root);
    diagnostics.push(...lockFile.diagnostics);
    if (lockFile.diagnostics.length === 0) {
      const { violations, unrecorded } = compareLocks(result.index, lockFile.entries);
      const notYet = (diagnostic: Diagnostic): Diagnostic =>
        diagnostic.code === "E_LOCK_MISSING" ? { ...diagnostic, code: "W_LOCK_UNRECORDED", severity: "warning", message: `${diagnostic.message}; after activation, cage lock records it` } : diagnostic;
      diagnostics.push(...violations, ...unrecorded.map(notYet));
      locks = "checked";
    }
  }
  return { diagnostics, validation: { mode: "candidate", designs: "checked", locks, implementations: "not-checked", tests: "not-checked", reviews: "not-checked", typescript: result.typescript } };
}

const outOfScope = (target: string, config: Pick<Config, "designs">, file = target) =>
  refusal("E_DRAFT", `${target} is not matched by the designs patterns (${config.designs.join(", ")}) or is excluded; it would not be a design`, file);

/** A new design: the sections the cage-design skill asks for, and one contract named after the document to rewrite. */
function scaffold(target: string): string {
  const title = path.posix.basename(target, DESIGN_SUFFIX);
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  const name = /^\p{L}/u.test(pascal) ? pascal : `Design${pascal}`;
  return [
    `# ${title}`,
    "",
    "## Purpose",
    "",
    "What the module is for and who depends on it.",
    "",
    "## Business rules",
    "",
    "1. A rule in plain words, as a person would state it.",
    "",
    "## Contracts",
    "",
    "```ts design",
    "/**",
    " * @contract",
    ` * @description What ${name} promises, in one sentence.`,
    " */",
    `export interface ${name} {`,
    "  run(): void;",
    "}",
    "```",
    "",
    "## Out of scope",
    "",
    "What has no design here, and why.",
    "",
    "## Open questions",
    "",
    "Decisions not made yet.",
    "",
  ].join("\n");
}

/**
 * The report as text: the diagnostics, a heading with the outcome and the counts, then one short line per fact — the
 * draft and the target and what happened to each, what the candidate check covered and what it did not, what was
 * not recorded, and the next command. Digests stay in the header and the JSON. `project` repeats the options that
 * chose the project (`--root`, `--config`) in the next command.
 */
export function formatDraftReport(report: DraftReport, project: readonly string[] = []): string {
  const lines = report.diagnostics.map(formatDiagnostic);
  const errors = report.diagnostics.filter(isError).length;
  const warnings = report.diagnostics.length - errors;
  const counts = [...(errors > 0 ? [plural(errors, "error")] : []), ...(warnings > 0 ? [plural(warnings, "warning")] : [])];
  const outcome = { created: "written", valid: "valid", invalid: "not valid", activated: "activated", refused: "refused" }[report.status];
  lines.push(`draft ${report.action}: ${outcome}${counts.length > 0 ? ` (${counts.join(", ")})` : ""}`);
  const command = (...words: string[]) => ["cage", ...words, ...project].map(shellWord).join(" ");
  const fact = (label: string, text: string) => lines.push(`  ${`${label}:`.padEnd(14)}${text}`);
  const validation = report.validation;
  const checked = () => {
    if (validation === null) {
      fact("checked", "nothing; the draft was not read as a candidate");
      return;
    }
    const locks = validation.locks === "checked";
    fact("checked", `designs${locks ? " and locks" : ""}, with the draft in place of the target`);
    fact("not checked", `${locks ? "" : "locks, "}implementations, tests, reviews`);
  };
  const removed = report.diagnostics.some(({ file, code }) => code === "E_ENVIRONMENT" && file === report.draft) ? "not removed" : "removed";
  switch (report.status) {
    case "created":
      fact("draft", `${report.draft} (written)`);
      fact("target", `${report.target} (${report.base === null ? "a new document, not written" : "unchanged"})`);
      fact("next", command("draft", "check", report.draft));
      break;
    case "valid":
    case "invalid":
      fact("draft", report.draft);
      fact("target", `${report.target} (unchanged)`);
      checked();
      fact("written", "nothing");
      if (report.status === "valid") fact("next", command("draft", "activate", report.draft));
      break;
    case "activated":
      fact("draft", `${report.draft} (${removed})`);
      fact("target", `${report.target} (${report.base === null ? "created" : "replaced"} with the draft, without its header)`);
      checked();
      fact("not recorded", `${LOCK_FILE}, .cage/review.json`);
      fact("next", command("check"));
      break;
    case "refused":
      fact("draft", `${report.draft} (${report.action === "create" ? "not written" : "kept"})`);
      fact("target", `${report.target} (unchanged)`);
      if (report.action === "activate") checked();
      break;
  }
  return `${lines.join("\n")}\n`;
}

/** A word of a shell command as typed: as it is when it is plain, else single-quoted. */
const shellWord = (word: string) => (/^[\w./@:+=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);
