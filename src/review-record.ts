import fs from "node:fs";
import path from "node:path";
import { compareDiagnostics, compareText, hasErrors, type Diagnostic } from "./diagnostic.ts";
import { writeOutput } from "./generated-files.ts";
import { checkImplementationPhase, type ImplementationPhaseOptions, type ImplementationPhaseResult } from "./implementation-phase.ts";
import { toProjectPath } from "./location.ts";
import { isText, parseRecordText, readRecordFile } from "./record-file.ts";
import { formatDiagnostic, plural } from "./report.ts";
import { collectMaterial, createFileReader, fingerprintOf } from "./review-material.ts";

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
                reason: { type: "string" },
                evidence: { type: ["string", "null"] },
                suggestedChange: { type: ["string", "null"] },
              },
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
  files: Record<string, string>;
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
  const { module, contract, fingerprint, files, findings } = value as Record<string, unknown>;
  const isFiles = typeof files === "object" && files !== null && Object.values(files).every(isText);
  return isText(module) && isText(contract) && isText(fingerprint) && isFiles && Array.isArray(findings) && findings.every(isFinding);
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

/**
 * What `check` says about the recorded reviews: a contract without one,
 * one whose material changed since, and every finding that is not
 * `adequate`. The level decides whether these are warnings or errors.
 */
export function checkReviews(root: string, result: ImplementationPhaseResult, level: "warn" | "require"): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { index } = result;
  if (!index) return diagnostics;
  const reviews = readReviewFile(root);
  if (reviews.diagnostics.length > 0) return reviews.diagnostics;
  const severity = level === "require" ? "error" : "warning";
  const code = (name: string) => `${level === "require" ? "E" : "W"}_REVIEW_${name}`;
  const { read } = createFileReader(root, diagnostics);

  for (const contract of index.contracts) {
    const subject = `contract "${contract.name}"`;
    const entry = reviews.entries.find((candidate) => candidate.module === contract.module && candidate.contract === contract.name);
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
    const { fingerprint, digests } = fingerprintOf(collectMaterial(result, contract.name, read).files);
    if (fingerprint !== entry.fingerprint) {
      const changed = Object.keys(digests).filter((file) => entry.files[file] !== digests[file]);
      const removed = Object.keys(entry.files).filter((file) => !Object.hasOwn(digests, file));
      const what = [...changed.map((file) => (Object.hasOwn(entry.files, file) ? `${file} changed` : `${file} is new`)), ...removed.map((file) => `${file} is no longer part of it`)];
      // The files may all match while the recorded fingerprint does not: the entry was edited or made by other rules.
      const since = what.length > 0 ? `since then: ${what.join(", ")}` : "its recorded fingerprint does not match its files";
      diagnostics.push({
        code: code("STALE"),
        severity,
        message: `The recorded review of ${subject} is for other material; ${since}. Review it again.`,
        ...contract.location,
        contract: contract.name,
      });
      continue;
    }
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
  return diagnostics;
}

export interface RecordReport {
  schemaVersion: 1;
  command: "review";
  ok: boolean;
  file: string;
  recorded: { module: string; contract: string; fingerprint: string; assessments: Record<Assessment, number> }[];
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
    const { fingerprint, digests } = fingerprintOf(collectMaterial(result, contract.name, read).files);
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
    if (unknown.length > 0 || unassessed.length > 0 || (invariants.length === 0 && verdict.findings.length === 0)) continue;

    const entry: ReviewEntry = { module: contract.module, contract: contract.name, fingerprint, files: digests, findings: verdict.findings };
    entries.set(keyOf(entry), entry);
    const assessments = Object.fromEntries(ASSESSMENTS.map((assessment) => [assessment, verdict.findings.filter((finding) => finding.assessment === assessment).length])) as Record<Assessment, number>;
    recorded.push({ module: contract.module, contract: contract.name, fingerprint, assessments });
  }
  if (hasErrors(diagnostics)) return report([]);
  for (const [key, entry] of entries) {
    if (result.index.contracts.some((contract) => contract.module === entry.module && contract.name === entry.contract)) continue;
    entries.delete(key);
    removed.push({ module: entry.module, contract: entry.contract });
  }

  try {
    fs.mkdirSync(path.dirname(path.join(root, REVIEW_FILE)), { recursive: true });
    writeOutput(path.join(root, REVIEW_FILE), formatReviewFile([...entries.values()].sort((a, b) => compareText(keyOf(a), keyOf(b)))));
  } catch (cause) {
    diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot write the review file: ${(cause as Error).message}`, file: REVIEW_FILE });
    return report([]);
  }
  return report(recorded);
}

export function formatRecordReport(report: RecordReport): string {
  const lines = report.recorded.map((entry) => {
    const counts = ASSESSMENTS.filter((assessment) => entry.assessments[assessment] > 0).map((assessment) => `${entry.assessments[assessment]} ${assessment}`);
    return `recorded  ${entry.contract} (${counts.join(", ")})`;
  });
  lines.push(...report.removed.map((entry) => `removed   ${entry.contract} (no longer in ${entry.module})`));
  lines.push(...report.diagnostics.map(formatDiagnostic));
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const removed = report.removed.length > 0 ? `, ${report.removed.length} removed` : "";
  lines.push(errors > 0 ? `review --record: ${plural(errors, "error")}, nothing recorded.` : `review --record: ${report.recorded.length} recorded${removed} in ${report.file}.`);
  return `${lines.join("\n")}\n`;
}
