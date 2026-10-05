import fs from "node:fs";
import path from "node:path";
import { compareDiagnostics, compareText, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { checkImplementationPhase, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { isText, parseRecordText, readRecordFile, writeRecordFile } from "./record-file.ts";
import { formatDiagnostic, plural } from "./report.ts";
import { collectMaterial, createFileReader, externalUses, fingerprintOf, type Material } from "./review-material.ts";

/** Relative to the project root. */
export const REVIEW_FILE = ".cage/review.json";

export const ASSESSMENTS = ["adequate", "weak", "unrelated", "insufficient-context"] as const;
export type Assessment = (typeof ASSESSMENTS)[number];

/** The verdict as a JSON Schema, for a reviewer that can be held to one. */
export const VERDICTS_SCHEMA = {
  type: "object",
  required: ["version", "verdicts"],
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    verdicts: {
      type: "array",
      items: {
        type: "object",
        required: ["contract", "fingerprint", "findings"],
        additionalProperties: false,
        properties: {
          contract: { type: "string" },
          fingerprint: { type: "string" },
          findings: {
            type: "array",
            items: {
              type: "object",
              required: ["invariant", "assessment", "reason", "evidence", "suggestedChange"],
              additionalProperties: false,
              properties: {
                invariant: { type: ["string", "null"] },
                assessment: { enum: [...ASSESSMENTS] },
                // Not blank: every finding says why, and on what.
                reason: { type: "string", pattern: "\\S" },
                evidence: { type: ["string", "null"], pattern: "\\S" },
                suggestedChange: { type: ["string", "null"] },
              },
              // Evidence is null only for insufficient-context.
              if: { properties: { assessment: { not: { const: "insufficient-context" } } } },
              then: { properties: { evidence: { type: "string" } } },
            },
          },
        },
      },
    },
  },
} as const;

export interface Finding {
  /** Null for a finding about the contract as a whole. */
  invariant: string | null;
  assessment: Assessment;
  reason: string;
  evidence: string | null;
  suggestedChange: string | null;
}

/** A recorded verdict: what was reviewed, by digest, and what the reviewer found. */
export interface ReviewEntry {
  module: string;
  contract: string;
  fingerprint: string;
  /** Digest of each part of the material, by key: `contract`, `implementation <file>#<name>`, `test <file>:<title>`. */
  material: Record<string, string>;
  findings: Finding[];
}

const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

function isFinding(value: unknown): value is Finding {
  if (typeof value !== "object" || value === null) return false;
  const { invariant, assessment, reason, evidence, suggestedChange } = value as Record<string, unknown>;
  return isTextOrNull(invariant) && (ASSESSMENTS as readonly unknown[]).includes(assessment) && isText(reason) && isTextOrNull(evidence) && isTextOrNull(suggestedChange);
}

function isEntry(value: unknown): value is ReviewEntry {
  if (typeof value !== "object" || value === null) return false;
  const { module, contract, fingerprint, material, findings } = value as Record<string, unknown>;
  const isMaterial = typeof material === "object" && material !== null && Object.values(material).every(isText);
  return isText(module) && isText(contract) && isText(fingerprint) && isMaterial && Array.isArray(findings) && findings.every(isFinding);
}

/** The recorded reviews; none when there is no review file yet. */
export const readReviewFile = (root: string) => readRecordFile(root, REVIEW_FILE, "review file", parseReviewEntries);

function parseReviewEntries(value: unknown): ReviewEntry[] | string {
  const { version, reviews } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(reviews) || !reviews.every(isEntry)) return 'expected { "version": 1, "reviews": [...] } as written by `cage review --record`.';
  return reviews;
}

export const formatReviewFile = (entries: readonly ReviewEntry[]) => `${JSON.stringify({ version: 1, reviews: entries }, null, 2)}\n`;

const keyOf = ({ module, contract }: Pick<ReviewEntry, "module" | "contract">) => `${module}\n${contract}`;

/** A part of the material, for a message: `the contract`, `implementation Name (file)`, `test "title" (file)`. */
function describePart(key: string): string {
  if (key === "contract") return "the contract declaration";
  const design = /^design (.+)$/.exec(key);
  if (design) return `the prose of ${design[1]}`;
  const dependency = /^dependency (.+)$/.exec(key);
  if (dependency) return `dependency ${dependency[1]}`;
  const implementation = /^implementation (.+)#([^#]+)$/.exec(key);
  if (implementation) return `implementation ${implementation[2]} (${implementation[1]})`;
  const test = /^test ([^:]+):(.*)$/.exec(key);
  if (test) return `test "${test[2]}" (${test[1]})`;
  return key;
}

/**
 * What the bounds of the review scope left out of a contract's fingerprint, and what could not be read:
 * a change there would not make the review outdated, so it is said, never left silent. The level is the
 * review level's: under "require" a fingerprint with holes is an error.
 */
export function scopeDiagnostics(material: Material, level: "warn" | "require"): Diagnostic[] {
  // A dependency that cannot be read is a hole of unknown size: the material cannot be established.
  const diagnostics: Diagnostic[] = material.unreadable.map(({ file, message }) => ({ code: "E_ENVIRONMENT", severity: "error" as const, message: `Cannot read a dependency of the review of "${material.contract.name}": ${message}`, file, contract: material.contract.name }));
  const listed = (entries: Material["beyond"], why: (entry: Material["beyond"][number]) => string) => {
    const shown = entries.slice(0, 5).map((entry) => `${entry.file} (${why(entry)})`);
    return `${shown.join(", ")}${entries.length > shown.length ? ` and ${entries.length - shown.length} more` : ""}`;
  };
  const limit = (message: string): Diagnostic => ({
    code: `${level === "require" ? "E" : "W"}_REVIEW_SCOPE_LIMIT`,
    severity: level === "require" ? "error" : "warning",
    message,
    ...material.contract.location,
    contract: material.contract.name,
  });
  const bounded = material.beyond.filter(({ why }) => why !== "outside");
  if (bounded.length > 0) {
    diagnostics.push(
      limit(
        `The fingerprint of the review of contract "${material.contract.name}" stops at the bounds of \`reviewDependencies\` (${material.dependencies.length} dependency files fingerprinted): a change in ${listed(bounded, ({ why }) => (why === "depth" ? "past the depth" : "past the file limit"))} would not make the review outdated. Raise "depth" or "maxFiles", or list files the contract does not depend on in "exclude", in .cage/config.json.`,
      ),
    );
  }
  const outside = material.beyond.filter(({ why }) => why === "outside");
  if (outside.length > 0) {
    diagnostics.push(
      limit(
        `The fingerprint of the review of contract "${material.contract.name}" leaves out what lies outside the project: a change in ${listed(outside, () => "a link out of the project")} would not make the review outdated. cage does not read files outside the project; move the file into it, or list it in "exclude" of \`reviewDependencies\` if the contract does not depend on it.`,
      ),
    );
  }
  return diagnostics;
}

/** What is recorded about a contract, as `check` sees it: a fresh verdict with its findings, or none. */
export interface ReviewStatus {
  /** A recorded verdict for the material as it is now. Null when there is none, or it is for other material. */
  findings: Finding[] | null;
}

export interface ReviewCheck {
  diagnostics: Diagnostic[];
  /** By contract name. */
  status: Map<string, ReviewStatus>;
}

/**
 * What `check` says about the recorded reviews: a contract without one,
 * one whose material changed since, and every finding that is not
 * `adequate`. The level decides whether these are warnings or errors.
 * `sourceFiles` are the project's implementation files, searched for who
 * outside the module imports an implementation of a contract whose
 * declaration changed: they depend on the old promise.
 */
export function checkReviews(root: string, result: ImplementationPhaseResult, level: "warn" | "require", sourceFiles: readonly string[] = []): ReviewCheck {
  const diagnostics: Diagnostic[] = [];
  const status = new Map<string, ReviewStatus>();
  const { index } = result;
  if (!index) return { diagnostics, status };
  const reviews = readReviewFile(root);
  if (reviews.diagnostics.length > 0) return { diagnostics: reviews.diagnostics, status };
  const severity = level === "require" ? "error" : "warning";
  const code = (name: string) => `${level === "require" ? "E" : "W"}_REVIEW_${name}`;
  const { read } = createFileReader(root, diagnostics);

  for (const contract of index.contracts) {
    const subject = `contract "${contract.name}"`;
    const entry = reviews.entries.find((candidate) => candidate.module === contract.module && candidate.contract === contract.name);
    status.set(contract.name, { findings: null });
    if (!entry) {
      diagnostics.push({
        code: code("MISSING"),
        severity,
        message: `Contract "${contract.name}" has no recorded review. Run \`cage review ${contract.name}\`, have the material reviewed, and record the verdict with \`cage review --record\`.`,
        ...contract.location,
        contract: contract.name,
      });
      continue;
    }
    const material = collectMaterial(result, contract.name, read);
    diagnostics.push(...scopeDiagnostics(material, level));
    const { fingerprint, digests } = fingerprintOf(material.parts);
    if (fingerprint !== entry.fingerprint) {
      const changed = Object.keys(digests).filter((key) => entry.material[key] !== digests[key]);
      const removed = Object.keys(entry.material).filter((key) => !Object.hasOwn(digests, key));
      const what = [...changed.map((key) => (Object.hasOwn(entry.material, key) ? `${describePart(key)} changed` : `${describePart(key)} is new`)), ...removed.map((key) => `${describePart(key)} is gone`)];
      // The files may all match while the recorded fingerprint does not: the entry was edited or made by other rules.
      const since = what.length > 0 ? `since then: ${what.join(", ")}` : "its recorded fingerprint does not match its files";
      // A changed declaration is a changed promise: whoever imports its implementation from outside the module relies on the old one.
      const users = changed.includes("contract") && result.compiler ? externalUses(root, result.compiler.ts, result.compiler.overlay, material.implementations, contract.module, contract.members.map((member) => member.name), sourceFiles) : [];
      const outside = users.length > 0 ? ` The contract changed and is used outside its module by ${users.map((use) => `${use.file}:${use.line}${use.members.length > 0 ? ` (${use.members.join(", ")})` : ""}`).join(", ")}: they rely on the old promise.` : "";
      diagnostics.push({
        code: code("STALE"),
        severity,
        message: `The recorded review of ${subject} is for other material; ${since}. Review it again.${outside}`,
        ...contract.location,
        contract: contract.name,
      });
      continue;
    }
    status.set(contract.name, { findings: entry.findings });
    for (const finding of entry.findings) {
      if (finding.assessment === "adequate") continue;
      const invariant = finding.invariant === null ? undefined : index.invariants.find((candidate) => candidate.contract === contract.name && candidate.id === finding.invariant);
      const about = finding.invariant === null ? "the contract as a whole" : `invariant \`${finding.invariant}\``;
      const suggestion = finding.suggestedChange ? ` Suggested: ${finding.suggestedChange}` : "";
      diagnostics.push({
        code: code("WEAK"),
        severity,
        message: `The review of ${subject} found ${about} ${finding.assessment}: ${finding.reason}${suggestion}`,
        ...(invariant?.location ?? contract.location),
        contract: contract.name,
        ...(finding.invariant === null ? {} : { invariant: finding.invariant }),
      });
    }
  }
  // An entry that no contract answers to any more says nothing about the designs; it goes when the next verdict is recorded.
  for (const entry of reviews.entries) {
    if (index.contracts.some((contract) => contract.module === entry.module && contract.name === entry.contract)) continue;
    diagnostics.push({
      code: code("STALE"),
      severity,
      message: `The review file has a review of contract "${entry.contract}" of ${entry.module}, which no longer exists there. \`cage review --record\` removes it.`,
      file: REVIEW_FILE,
    });
  }
  return { diagnostics, status };
}

export interface RecordReport {
  schemaVersion: 1;
  command: "review";
  ok: boolean;
  file: string;
  /**
   * `assessments` count the findings about invariants, `contractAssessments` those about the contract as a whole;
   * `notes` are the contract-level findings, first sentence each, led by the assessment when it is not adequate.
   */
  recorded: { module: string; contract: string; fingerprint: string; assessments: Record<Assessment, number>; contractAssessments: Record<Assessment, number>; notes: string[] }[];
  /** Entries of contracts that no longer exist, taken out of the file. */
  removed: { module: string; contract: string }[];
  diagnostics: Diagnostic[];
}

/**
 * `cage review --record <verdicts>`: records the verdicts of a review in
 * the review file, each against the material as it is now. A verdict for
 * other material, for an unknown contract or invariant, or that leaves an
 * invariant unassessed is refused, and then nothing is recorded.
 * `verdictsFile` is an absolute path.
 */
export function recordVerdicts(options: ImplementationPhaseOptions, verdictsFile: string): RecordReport {
  const root = path.resolve(options.root);
  const diagnostics: Diagnostic[] = [];
  const removed: RecordReport["removed"] = [];
  const report = (recorded: RecordReport["recorded"]): RecordReport => ({
    schemaVersion: 1,
    command: "review",
    ok: !hasErrors(diagnostics),
    file: REVIEW_FILE,
    recorded,
    removed: hasErrors(diagnostics) ? [] : removed,
    diagnostics: diagnostics.sort(compareDiagnostics),
  });
  const verdictsPath = toProjectPath(root, verdictsFile);
  const refuse = (message: string) => {
    diagnostics.push({ code: "E_CONFIG", severity: "error", message: `The verdicts are not usable: ${message}`, file: verdictsPath });
    return report([]);
  };

  type Verdict = { contract: string; fingerprint: string; findings: Finding[] };
  const isVerdict = (item: unknown): item is Verdict => {
    if (typeof item !== "object" || item === null) return false;
    const { contract, fingerprint, findings } = item as Record<string, unknown>;
    return isText(contract) && isText(fingerprint) && Array.isArray(findings) && findings.every(isFinding);
  };
  const parseVerdicts = (value: unknown): Verdict[] | string => {
    const { version, verdicts } = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    if (version !== 1 || !Array.isArray(verdicts)) return 'expected { "version": 1, "verdicts": [...] } as the review asks for.';
    const broken = verdicts.findIndex((item) => !isVerdict(item));
    if (broken !== -1) return `verdict ${broken + 1} is not of the shape the review asks for: contract, fingerprint and findings with invariant, assessment, reason, evidence and suggestedChange.`;
    return verdicts as Verdict[];
  };
  let text: string;
  try {
    text = fs.readFileSync(verdictsFile, "utf8");
  } catch (cause) {
    return refuse((cause as Error).message);
  }
  const given = parseRecordText(text, parseVerdicts);
  if (typeof given === "string") return refuse(given);
  if (given.length === 0) return refuse("it has no verdict.");

  // The check's own findings were part of the reviewed material; only what stops the material from being established is reported here.
  const result = checkImplementationPhase(options);
  if (!result.index || !result.linking) {
    diagnostics.push(...result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"));
    if (!hasErrors(diagnostics)) diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: "The implementations and tests could not be read, so the material of a review cannot be established." });
    return report([]);
  }
  const existing = readReviewFile(root);
  diagnostics.push(...existing.diagnostics);
  if (existing.diagnostics.length > 0) return report([]);

  const { read } = createFileReader(root, diagnostics);
  const entries = new Map(existing.entries.map((entry) => [keyOf(entry), entry]));
  const recorded: RecordReport["recorded"] = [];
  for (const [order, verdict] of given.entries()) {
    const contract = result.index.contracts.find((candidate) => candidate.name === verdict.contract);
    const problem = (message: string) => diagnostics.push({ code: "E_REVIEW_VERDICT", severity: "error", message, file: verdictsPath, contract: verdict.contract });
    if (!contract) {
      diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: `The verdict names contract "${verdict.contract}", which is not in the designs.`, file: verdictsPath });
      continue;
    }
    if (given.findIndex((other) => other.contract === verdict.contract) !== order) {
      problem(`There is more than one verdict for "${contract.name}"; one contract gets one verdict.`);
      continue;
    }
    const material = collectMaterial(result, contract.name, read);
    // A fingerprint with a dependency that could not be read is not the material: nothing is recorded against it.
    if (material.unreadable.length > 0) {
      diagnostics.push(...scopeDiagnostics(material, "warn").filter((diagnostic) => diagnostic.code === "E_ENVIRONMENT").map((diagnostic) => ({ ...diagnostic, message: `${diagnostic.message}. The verdict cannot be recorded against material that is not all there.` })));
      continue;
    }
    const { fingerprint, digests } = fingerprintOf(material.parts);
    if (verdict.fingerprint !== fingerprint) {
      problem(`The verdict for "${contract.name}" is for fingerprint ${verdict.fingerprint}, but the material is now ${fingerprint}: it changed since the review. Review it again.`);
      continue;
    }
    const invariants = result.index.invariants.filter((invariant) => invariant.contract === contract.name).map((invariant) => invariant.id);
    const unknown = verdict.findings.filter((finding) => finding.invariant !== null && !invariants.includes(finding.invariant)).map((finding) => finding.invariant);
    const unassessed = invariants.filter((id) => !verdict.findings.some((finding) => finding.invariant === id));
    if (unknown.length > 0) problem(`The verdict for "${contract.name}" assesses invariants it does not have: ${unknown.map((id) => `\`${id}\``).join(", ")}.`);
    if (unassessed.length > 0) problem(`The verdict for "${contract.name}" leaves invariants unassessed: ${unassessed.map((id) => `\`${id}\``).join(", ")}.`);
    if (invariants.length === 0 && verdict.findings.length === 0) problem(`The verdict for "${contract.name}" has no finding; a contract without invariants gets one about the contract as a whole.`);
    // A finding says why, and on what: a file and line, except one that says the context was not enough.
    const blank = (text: string | null) => text === null || text.trim() === "";
    const about = (finding: Finding) => (finding.invariant === null ? "the contract as a whole" : `\`${finding.invariant}\``);
    const named = (findings: Finding[]) => [...new Set(findings.map(about))].join(", ");
    const unreasoned = verdict.findings.filter((finding) => blank(finding.reason));
    const unevidenced = verdict.findings.filter((finding) => (finding.assessment === "insufficient-context" ? finding.evidence !== null && blank(finding.evidence) : blank(finding.evidence)));
    if (unreasoned.length > 0) problem(`The verdict for "${contract.name}" has findings without a reason: ${named(unreasoned)}. Every finding says why.`);
    if (unevidenced.length > 0) {
      problem(`The verdict for "${contract.name}" has findings without evidence: ${named(unevidenced)}. Every finding names the file and line it rests on; only an insufficient-context one may have null instead.`);
    }
    if (unknown.length > 0 || unassessed.length > 0 || (invariants.length === 0 && verdict.findings.length === 0) || unreasoned.length > 0 || unevidenced.length > 0) continue;

    const entry: ReviewEntry = { module: contract.module, contract: contract.name, fingerprint, material: digests, findings: verdict.findings };
    entries.set(keyOf(entry), entry);
    // A contract-level finding is not an assessment of an invariant: it is counted apart, and `check` reports one that is not adequate.
    const { assessments, contractAssessments } = countAssessments(verdict.findings);
    recorded.push({ module: contract.module, contract: contract.name, fingerprint, assessments, contractAssessments, notes: notesOf(verdict.findings) });
  }
  if (hasErrors(diagnostics)) return report([]);
  for (const [key, entry] of entries) {
    if (result.index.contracts.some((contract) => contract.module === entry.module && contract.name === entry.contract)) continue;
    entries.delete(key);
    removed.push({ module: entry.module, contract: entry.contract });
  }

  try {
    writeRecordFile(path.join(root, REVIEW_FILE), formatReviewFile([...entries.values()].sort((a, b) => compareText(keyOf(a), keyOf(b)))));
  } catch (cause) {
    diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot write the review file: ${(cause as Error).message}`, file: REVIEW_FILE });
    return report([]);
  }
  return report(recorded);
}

/** The assessments of a verdict, counted over the invariants and over the contract as a whole apart. */
export function countAssessments(findings: readonly Finding[]): { assessments: Record<Assessment, number>; contractAssessments: Record<Assessment, number> } {
  const count = (about: readonly Finding[]) => Object.fromEntries(ASSESSMENTS.map((assessment) => [assessment, about.filter((finding) => finding.assessment === assessment).length])) as Record<Assessment, number>;
  return { assessments: count(findings.filter((finding) => finding.invariant !== null)), contractAssessments: count(findings.filter((finding) => finding.invariant === null)) };
}

/** Whether any count is of an assessment other than adequate. */
export const findsFault = (counts: Record<Assessment, number>) => ASSESSMENTS.some((assessment) => assessment !== "adequate" && counts[assessment] > 0);

/**
 * The contract-level findings as notes, first sentence each. An adequate one is an observation; one that is not
 * says so first, since `check` reports it as a finding against the contract as a whole.
 */
export function notesOf(findings: readonly Finding[]): string[] {
  return findings.filter((finding) => finding.invariant === null).map((finding) => `${finding.assessment === "adequate" ? "" : `${finding.assessment}: `}${firstSentence(finding.reason)}`);
}

/** The first sentence of a reason: what `check` and `--record` print of it. */
export function firstSentence(text: string): string {
  return /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text;
}

export function formatRecordReport(report: RecordReport): string {
  const lines = report.recorded.flatMap((entry) => {
    const listed = (counts: Record<Assessment, number>) => ASSESSMENTS.filter((assessment) => counts[assessment] > 0).map((assessment) => `${counts[assessment]} ${assessment}`).join(", ");
    const counts = listed(entry.assessments);
    const whole = findsFault(entry.contractAssessments) ? `; the contract as a whole: ${listed(entry.contractAssessments)}` : "";
    const notes = entry.notes.length === 0 ? "" : `; ${plural(entry.notes.length, "note")}`;
    // ✓ when every finding, about an invariant or the contract as a whole, is adequate; ! when the verdict found something. Either way it is what the reviewer said.
    const mark = findsFault(entry.assessments) || findsFault(entry.contractAssessments) ? "!" : "✓";
    return [`${mark} recorded  ${entry.contract} (${counts === "" ? "no invariants" : counts}${whole}${notes})`, ...entry.notes.map((note) => `            note: ${note}`)];
  });
  lines.push(...report.removed.map((entry) => `- removed   ${entry.contract} (no longer in ${entry.module})`));
  lines.push(...report.diagnostics.map(formatDiagnostic));
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const removed = report.removed.length > 0 ? `, ${report.removed.length} removed` : "";
  lines.push(errors > 0 ? `review --record: ${plural(errors, "error")}, nothing recorded.` : `review --record: ${report.recorded.length} recorded${removed} in ${report.file}; a reviewer's assessment, not a test run.`);
  return `${lines.join("\n")}\n`;
}
