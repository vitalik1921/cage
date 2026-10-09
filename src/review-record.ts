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

/** How many changed parts a `REVIEW_STALE` message names; the rest is a count, and `cage review` lists them all. */
const MAX_LISTED_PARTS = 10;

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

/**
 * A recorded verdict: what was reviewed, by digest, and what the reviewer found. Or, with `accepted`, an acceptance:
 * the material as it was, taken as reviewed without a verdict (`cage review --accept`), with no findings.
 */
export interface ReviewEntry {
  module: string;
  contract: string;
  fingerprint: string;
  /** Digest of each part of the material, by key: `contract`, `implementation <file>#<name>`, `test <file>:<title>`. */
  material: Record<string, string>;
  findings: Finding[];
  /** Present and true only for an acceptance: nobody judged the material, and nothing attests the tests. */
  accepted?: true;
}

const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);

function isFinding(value: unknown): value is Finding {
  if (typeof value !== "object" || value === null) return false;
  const { invariant, assessment, reason, evidence, suggestedChange } = value as Record<string, unknown>;
  return isTextOrNull(invariant) && (ASSESSMENTS as readonly unknown[]).includes(assessment) && isText(reason) && isTextOrNull(evidence) && isTextOrNull(suggestedChange);
}

function isEntry(value: unknown): value is ReviewEntry {
  if (typeof value !== "object" || value === null) return false;
  const { module, contract, fingerprint, material, findings, accepted } = value as Record<string, unknown>;
  const isMaterial = typeof material === "object" && material !== null && Object.values(material).every(isText);
  // An acceptance has no findings: a finding is a judgement, and nobody made one.
  const isAcceptance = accepted === undefined || (accepted === true && Array.isArray(findings) && findings.length === 0);
  return isText(module) && isText(contract) && isText(fingerprint) && isMaterial && Array.isArray(findings) && findings.every(isFinding) && isAcceptance;
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

/** Unreadable dependencies prevent a complete fingerprint, independently of the review policy. */
export function materialErrors(material: Material): Diagnostic[] {
  return material.unreadable.map(({ file, message }) => ({ code: "E_ENVIRONMENT", severity: "error", message: `cannot read a dependency of ${material.contract.name}: ${message}`, file, contract: material.contract.name }));
}

/** What is recorded about a contract, as `check` sees it: a fresh verdict with its findings, a fresh acceptance, or none. */
export interface ReviewStatus {
  /** A recorded verdict for the material as it is now. Null when there is none, or it is for other material. */
  findings: Finding[] | null;
  /** The material as it is now was accepted without a review: `check` asks for none, and nothing attests the tests. */
  accepted: boolean;
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
  const { read } = createFileReader(root, diagnostics, result.linking?.sources);

  for (const contract of index.contracts) {
    const subject = `contract "${contract.name}"`;
    const entry = reviews.entries.find((candidate) => candidate.module === contract.module && candidate.contract === contract.name);
    status.set(contract.name, { findings: null, accepted: false });
    if (!entry) {
      diagnostics.push({
        code: code("MISSING"),
        severity,
        message: `${contract.name}`,
        ...contract.location,
        contract: contract.name,
      });
      continue;
    }
    const material = collectMaterial(result, contract.name, read);
    diagnostics.push(...materialErrors(material));
    const { fingerprint, digests } = fingerprintOf(material.parts, entry.fingerprint);
    if (fingerprint !== entry.fingerprint) {
      const changed = Object.keys(digests).filter((key) => entry.material[key] !== digests[key]);
      const removed = Object.keys(entry.material).filter((key) => !Object.hasOwn(digests, key));
      const what = [...changed.map((key) => (Object.hasOwn(entry.material, key) ? `${describePart(key)} changed` : `${describePart(key)} is new`)), ...removed.map((key) => `${describePart(key)} is gone`)];
      // The files may all match while the recorded fingerprint does not: the entry was edited or made by other rules.
      // One part a line, ten at most: the full list is the index's (`cage review`), the message is a pointer.
      const shown = what.length > MAX_LISTED_PARTS ? [...what.slice(0, MAX_LISTED_PARTS), `and ${what.length - MAX_LISTED_PARTS} more: \`cage review ${contract.name}\` lists them`] : what;
      const since = what.length > 0 ? `\n${shown.map((item) => `- ${item}`).join("\n")}` : ": no part differs, the fingerprint does";
      // A changed declaration is a changed promise: whoever imports its implementation from outside the module relies on the old one.
      const users = changed.includes("contract") && result.compiler ? externalUses(root, result.compiler.ts, result.compiler.overlay, material.implementations, contract.module, contract.members.map((member) => member.name), sourceFiles) : [];
      const outside = users.length > 0 ? `\nused outside the module by ${users.map((use) => `${use.file}:${use.line}${use.members.length > 0 ? ` (${use.members.join(", ")})` : ""}`).join(", ")}` : "";
      // An acceptance was never a review; it is named as such.
      const record = `${contract.name}${entry.accepted ? " (accepted without a review)" : ""}${since}`;
      diagnostics.push({
        code: code("STALE"),
        severity,
        message: `${record}${outside}`,
        review: { changes: [...changed.map(part => ({ part, change: Object.hasOwn(entry.material, part) ? "changed" as const : "new" as const })), ...removed.map(part => ({ part, change: "gone" as const }))] },
        ...contract.location,
        contract: contract.name,
      });
      continue;
    }
    status.set(contract.name, { findings: entry.accepted ? null : entry.findings, accepted: entry.accepted === true });
    for (const finding of entry.findings) {
      if (finding.assessment === "adequate") continue;
      const invariant = finding.invariant === null ? undefined : index.invariants.find((candidate) => candidate.contract === contract.name && candidate.id === finding.invariant);
      const about = finding.invariant === null ? "the contract as a whole" : `invariant \`${finding.invariant}\``;
      const suggestion = finding.suggestedChange ? `\nsuggested: ${finding.suggestedChange}` : "";
      diagnostics.push({
        code: code("WEAK"),
        severity,
        message: `${contract.name}${finding.invariant === null ? " (the contract as a whole)" : `.${finding.invariant}`} ${finding.assessment}\n${finding.reason}${suggestion}`,
        review: { finding: { assessment: finding.assessment, reason: finding.reason } },
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
      message: `${entry.contract} (${entry.module}) is not in the designs`,
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
    diagnostics.push({ code: "E_CONFIG", severity: "error", message: `verdicts not usable: ${message}`, file: verdictsPath });
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
  if (given.length === 0) return refuse("no verdict");

  // The check's own findings were part of the reviewed material; only what stops the material from being established is reported here.
  const result = checkImplementationPhase(options);
  if (!result.index || !result.linking) {
    diagnostics.push(...result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"));
    if (!hasErrors(diagnostics)) diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: "implementations and tests not read" });
    return report([]);
  }
  const existing = readReviewFile(root);
  diagnostics.push(...existing.diagnostics);
  if (existing.diagnostics.length > 0) return report([]);

  const { read } = createFileReader(root, diagnostics, result.linking?.sources);
  const entries = new Map(existing.entries.map((entry) => [keyOf(entry), entry]));
  const recorded: RecordReport["recorded"] = [];
  for (const [order, verdict] of given.entries()) {
    const contract = result.index.contracts.find((candidate) => candidate.name === verdict.contract);
    const problem = (message: string) => diagnostics.push({ code: "E_REVIEW_VERDICT", severity: "error", message, file: verdictsPath, contract: verdict.contract });
    if (!contract) {
      diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: `no contract "${verdict.contract}"`, file: verdictsPath });
      continue;
    }
    if (given.findIndex((other) => other.contract === verdict.contract) !== order) {
      problem(`${contract.name}: two verdicts`);
      continue;
    }
    const material = collectMaterial(result, contract.name, read);
    // A fingerprint with a dependency that could not be read is not the material: nothing is recorded against it.
    if (material.unreadable.length > 0) {
      diagnostics.push(...materialErrors(material).map((diagnostic) => ({ ...diagnostic, message: `${diagnostic.message}; nothing recorded` })));
      continue;
    }
    const { fingerprint, digests } = fingerprintOf(material.parts);
    if (verdict.fingerprint !== fingerprint) {
      problem(`${contract.name}: fingerprint ${verdict.fingerprint} given, the material is ${fingerprint}`);
      continue;
    }
    const invariants = result.index.invariants.filter((invariant) => invariant.contract === contract.name).map((invariant) => invariant.id);
    const unknown = verdict.findings.filter((finding) => finding.invariant !== null && !invariants.includes(finding.invariant)).map((finding) => finding.invariant);
    const unassessed = invariants.filter((id) => !verdict.findings.some((finding) => finding.invariant === id));
    if (unknown.length > 0) problem(`${contract.name}: no such invariants ${unknown.map((id) => `\`${id}\``).join(", ")}`);
    if (unassessed.length > 0) problem(`${contract.name}: unassessed ${unassessed.map((id) => `\`${id}\``).join(", ")}`);
    if (invariants.length === 0 && verdict.findings.length === 0) problem(`${contract.name}: no finding`);
    // A finding says why, and on what: a file and line, except one that says the context was not enough.
    const blank = (text: string | null) => text === null || text.trim() === "";
    const about = (finding: Finding) => (finding.invariant === null ? "the contract as a whole" : `\`${finding.invariant}\``);
    const named = (findings: Finding[]) => [...new Set(findings.map(about))].join(", ");
    const unreasoned = verdict.findings.filter((finding) => blank(finding.reason));
    const unevidenced = verdict.findings.filter((finding) => (finding.assessment === "insufficient-context" ? finding.evidence !== null && blank(finding.evidence) : blank(finding.evidence)));
    if (unreasoned.length > 0) problem(`${contract.name}: no reason for ${named(unreasoned)}`);
    if (unevidenced.length > 0) {
      problem(`${contract.name}: no evidence for ${named(unevidenced)}`);
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

export interface AcceptReport {
  schemaVersion: 1;
  command: "review";
  ok: boolean;
  file: string;
  /** "needed": the contracts without a record of their current material; the default. */
  selection: "all" | "named" | "needed";
  /** `replaced`: what the acceptance took the place of — a verdict or an acceptance, for this material (`current`) or for other material. */
  accepted: { module: string; contract: string; fingerprint: string; invariants: number; replaced: { kind: "verdict" | "acceptance"; current: boolean } | null }[];
  /** Contracts left with their record: a verdict or an acceptance for the material as it is now that the selection did not replace. */
  kept: { module: string; contract: string; record: "verdict" | "acceptance" }[];
  /** Entries of contracts that no longer exist, taken out of the file. */
  removed: { module: string; contract: string }[];
  diagnostics: Diagnostic[];
}

/**
 * `cage review --accept`: records, for each selected contract, that its
 * material as it is now is taken as reviewed without a verdict. `check`
 * then asks for no review of it until the material changes, and counts it
 * apart from what a reviewer attested. Without names the contracts without
 * a fresh record are selected and a fresh verdict is kept; a named contract
 * and `--all` replace a verdict too. An acceptance already recorded for the
 * same material is kept as it is. Nothing is recorded when a contract is
 * unknown or the material of one cannot be established.
 */
export function acceptContracts(options: ImplementationPhaseOptions, names: readonly string[] | "all" | "needed"): AcceptReport {
  const root = path.resolve(options.root);
  const diagnostics: Diagnostic[] = [];
  const selection = typeof names === "string" ? names : "named";
  const removed: AcceptReport["removed"] = [];
  const kept: AcceptReport["kept"] = [];
  const report = (accepted: AcceptReport["accepted"]): AcceptReport => ({
    schemaVersion: 1,
    command: "review",
    ok: !hasErrors(diagnostics),
    file: REVIEW_FILE,
    selection,
    accepted,
    kept: hasErrors(diagnostics) ? [] : kept,
    removed: hasErrors(diagnostics) ? [] : removed,
    diagnostics: diagnostics.sort(compareDiagnostics),
  });

  const result = checkImplementationPhase(options);
  if (!result.index || !result.linking) {
    diagnostics.push(...result.diagnostics.filter((diagnostic) => diagnostic.severity === "error"));
    if (!hasErrors(diagnostics)) diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: "implementations and tests not read" });
    return report([]);
  }
  const existing = readReviewFile(root);
  diagnostics.push(...existing.diagnostics);
  if (existing.diagnostics.length > 0) return report([]);

  const { index } = result;
  let selected: typeof index.contracts;
  if (names === "needed" || names === "all") {
    selected = [...index.contracts];
  } else {
    selected = [];
    for (const name of names) {
      const contract = index.contracts.find((candidate) => candidate.name === name);
      if (!contract) diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: `no contract "${name}"` });
      else if (!selected.includes(contract)) selected.push(contract);
    }
  }
  if (hasErrors(diagnostics)) return report([]);
  selected.sort((a, b) => compareText(a.module, b.module) || compareText(a.name, b.name));

  const { read } = createFileReader(root, diagnostics, result.linking?.sources);
  const entries = new Map(existing.entries.map((entry) => [keyOf(entry), entry]));
  const accepted: AcceptReport["accepted"] = [];
  for (const contract of selected) {
    const material = collectMaterial(result, contract.name, read);
    // A fingerprint with a dependency that could not be read is not the material: nothing is recorded against it.
    if (material.unreadable.length > 0) {
      diagnostics.push(...materialErrors(material).map((diagnostic) => ({ ...diagnostic, message: `${diagnostic.message}; not accepted` })));
      continue;
    }
    const { fingerprint, digests } = fingerprintOf(material.parts);
    const key = keyOf({ module: contract.module, contract: contract.name });
    const prior = entries.get(key);
    const current = prior !== undefined && prior.fingerprint === fingerprintOf(material.parts, prior.fingerprint).fingerprint;
    const kind = prior?.accepted ? "acceptance" : "verdict";
    // A fresh verdict stands unless the contract was named; a fresh acceptance is the same record and stays as it is.
    if (prior && current && (kind === "acceptance" || names === "needed")) {
      kept.push({ module: contract.module, contract: contract.name, record: kind });
      continue;
    }
    entries.set(key, { module: contract.module, contract: contract.name, fingerprint, material: digests, findings: [], accepted: true });
    const invariants = index.invariants.filter((invariant) => invariant.contract === contract.name).length;
    accepted.push({ module: contract.module, contract: contract.name, fingerprint, invariants, replaced: prior ? { kind, current } : null });
  }
  if (hasErrors(diagnostics)) return report([]);
  for (const [key, entry] of entries) {
    if (index.contracts.some((contract) => contract.module === entry.module && contract.name === entry.contract)) continue;
    entries.delete(key);
    removed.push({ module: entry.module, contract: entry.contract });
  }
  if (accepted.length === 0 && removed.length === 0) return report([]);

  try {
    writeRecordFile(path.join(root, REVIEW_FILE), formatReviewFile([...entries.values()].sort((a, b) => compareText(keyOf(a), keyOf(b)))));
  } catch (cause) {
    diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot write the review file: ${(cause as Error).message}`, file: REVIEW_FILE });
    return report([]);
  }
  return report(accepted);
}

export function formatAcceptReport(report: AcceptReport): string {
  const lines = report.accepted.map((entry) => {
    const replaced =
      entry.replaced === null ? "no record before" : entry.replaced.current ? `replaces the ${entry.replaced.kind} for this material` : `replaces an outdated ${entry.replaced.kind}`;
    // ○, as in the packet: the material is recorded, and nothing is known about the tests.
    return `○ accepted  ${entry.contract} (${plural(entry.invariants, "invariant")}, ${replaced})`;
  });
  lines.push(...report.kept.map((entry) => `= kept      ${entry.contract} (${entry.record === "verdict" ? "a recorded verdict" : "an acceptance"} for this material)`));
  lines.push(...report.removed.map((entry) => `- removed   ${entry.contract} (no longer in ${entry.module})`));
  lines.push(...report.diagnostics.map(formatDiagnostic));
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const kept = report.kept.length > 0 ? `, ${report.kept.length} kept` : "";
  const removed = report.removed.length > 0 ? `, ${report.removed.length} removed` : "";
  if (errors > 0) lines.push(`review --accept: ${plural(errors, "error")}, nothing recorded.`);
  else if (report.accepted.length === 0) lines.push(`review --accept: nothing to accept${kept}${removed}${report.selection === "needed" ? ": every contract has a record of its material as it is now" : ""}.`);
  else lines.push(`review --accept: ${report.accepted.length} accepted without a review${kept}${removed} in ${report.file}; check asks for no review of their material as it is now, and nothing attests that their tests check the invariants.`);
  return `${lines.join("\n")}\n`;
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
