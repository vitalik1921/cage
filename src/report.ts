import type { CheckReport } from "./check.ts";
import { compareText, isError, type Diagnostic, type RelatedLocation } from "./diagnostic.ts";
import type { LockReport } from "./lock-command.ts";

function formatLocation({ file, line, column }: Pick<RelatedLocation, "file" | "line" | "column">): string {
  if (file === undefined) return "";
  return line === undefined ? `${file}: ` : `${file}:${line}:${column}: `;
}

/**
 * One diagnostic as text: the code first, so that what kind of thing it is reads before where; then the severity and
 * the place on the same line; the message on the lines below, indented, one list item per line where the message has
 * a list. Related places follow, indented, as `file:line:column: message`.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const { file, line, column } = diagnostic;
  const where = file === undefined ? "" : line === undefined ? ` at ${file}` : ` at ${file}:${line}:${column}`;
  const ts = diagnostic.tsCode === undefined ? "" : ` (TS${diagnostic.tsCode})`;
  const lines = [`${diagnostic.code}: ${diagnostic.severity}${where}${ts}`, ...diagnostic.message.split("\n").map((text) => `  ${text}`)];
  for (const related of diagnostic.related ?? []) lines.push(`  ${formatLocation(related)}${related.message.replaceAll("\n", "\n  ")}`);
  return lines.join("\n");
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function countBySeverity(diagnostics: readonly Diagnostic[]) {
  const errors = diagnostics.filter(isError).length;
  return { errors, warnings: diagnostics.length - errors };
}

/**
 * How much a diagnostic matters to a reader who sees only part of the report: what makes the check unusable, what fails
 * it, what blocks the gate at any review level, the rest. Within a rank the order of the report stands.
 */
function rank(diagnostic: Diagnostic): number {
  if (diagnostic.code === "E_CONFIG" || diagnostic.code === "E_ENVIRONMENT") return 0;
  if (isError(diagnostic)) return 1;
  if (/REVIEW_(MISSING|STALE)$/.test(diagnostic.code)) return 2;
  return 3;
}

/**
 * The report with at most `max` diagnostics, the ones that matter most, in the order of the report; what is left out is
 * counted in `omitted`, by code. `ok` and the counts stay those of the whole check: a limit changes what is shown, not
 * what was found.
 */
export function limitCheckReport(report: CheckReport, max: number | "all"): CheckReport {
  if (max === "all") return report;
  const ordered = report.diagnostics.map((diagnostic, index) => ({ diagnostic, index, rank: rank(diagnostic) })).sort((a, b) => a.rank - b.rank || a.index - b.index);
  const shown = ordered.slice(0, max).sort((a, b) => a.index - b.index).map(({ diagnostic }) => diagnostic);
  const left = ordered.slice(max).map(({ diagnostic }) => diagnostic);
  const counted = new Map<string, number>();
  for (const { code } of left) counted.set(code, (counted.get(code) ?? 0) + 1);
  const byCode = Object.fromEntries([...counted].sort(([codeA, a], [codeB, b]) => b - a || compareText(codeA, codeB)));
  const { errors, warnings } = countBySeverity(left);
  return { ...report, omitted: { limit: max, count: left.length, errors, warnings, byCode }, diagnostics: shown };
}

/** The line that stands for the diagnostics a limit left out: how many, of which codes, and how to see them. */
function formatOmitted({ omitted }: CheckReport): string[] {
  if (omitted.count === 0) return [];
  const codes = Object.entries(omitted.byCode).map(([code, count]) => `${count} ${code}`).join(", ");
  return [`${omitted.count} more not shown (${codes}): the report shows ${omitted.limit} at most. Fix what is shown and check again, or pass --max-diagnostics all ("maxDiagnostics" in .cage/config.json).`];
}

export function formatCheckReport(report: CheckReport): string {
  const { counts, scope } = report;
  // The counts are of the whole check: a limit on what is shown changes nothing here.
  const errors = countBySeverity(report.diagnostics).errors + report.omitted.errors;
  const warnings = countBySeverity(report.diagnostics).warnings + report.omitted.warnings;
  const { version, source, fallbackReason } = scope.typescript;
  const compiler = `TypeScript ${version} (${fallbackReason === undefined ? source : `${source}; ${fallbackReason}`})`;
  const lines = [...report.diagnostics.map(formatDiagnostic), ...formatOmitted(report)];

  const facts = [plural(scope.designFiles.length, "design")];
  // Without an index there is nothing to count: an earlier error stopped the check.
  if (counts.contracts === null || counts.data === null || counts.invariants === null) {
    facts.push("contracts not indexed");
  } else {
    facts.push(plural(counts.contracts, "contract"), plural(counts.data, "data type"), plural(counts.invariants, "invariant"));
    if (report.phase === "implementation") {
      if (counts.implementations === null || counts.testDeclarations === null || counts.linkedInvariants === null) {
        facts.push("implementations and tests not checked");
      } else {
        facts.push(plural(counts.implementations, "implementation"));
        // Four different things, never one number: a link is a tag; active is what the test's text shows; whether the
        // test passes is the runner's to say; what a test proves is the review's attestation.
        // Invariants behind a rejected tag are not "missing a test" yet; saying so keeps a half-fixed file from looking nearly done.
        const unchecked = counts.uncheckedInvariants ? `, ${counts.uncheckedInvariants} not checked while a rejected tag names their contract` : "";
        const tests = `tests: ${plural(counts.testDeclarations, "declaration")} (${counts.activeTestDeclarations} active), ${counts.linkedInvariants} of ${plural(counts.invariants, "invariant")} linked, ${counts.activeInvariants} to an active test${unchecked}, not run by cage`;
        // An acceptance is a record without a verdict: it is neither attested nor waiting for a review, and it is said apart.
        const accepted = counts.acceptedContracts ? `, ${plural(counts.acceptedContracts, "contract")} accepted without review (${plural(counts.acceptedInvariants ?? 0, "invariant")})` : "";
        const reviews =
          counts.reviewedInvariants === null || counts.weakInvariants === null
            ? "reviews: not checked"
            : `reviews: ${counts.reviewedInvariants} attested adequate, ${counts.weakInvariants} found weak, ${counts.invariants - counts.reviewedInvariants - counts.weakInvariants - (counts.acceptedInvariants ?? 0)} unreviewed${counts.weakContracts ? `, ${plural(counts.weakContracts, "contract")} found weak as a whole` : ""}${accepted}`;
        lines.push(`check: ${facts.join(", ")}; ${tests}; ${reviews}; ${plural(errors, "error")}, ${plural(warnings, "warning")}. ${compiler}.${scope.lockBase === null ? "" : ` Locks compared with ${scope.lockBase}.`}`);
        return `${lines.join("\n")}\n`;
      }
    }
  }
  const command = report.phase === "design" ? "check --phase design" : "check";
  const locks = scope.lockBase === null ? "" : ` Locks compared with ${scope.lockBase}.`;
  lines.push(`${command}: ${facts.join(", ")}; ${plural(errors, "error")}, ${plural(warnings, "warning")}. ${compiler}.${locks}`);
  return `${lines.join("\n")}\n`;
}

export function formatLockReport(report: LockReport): string {
  const lines = report.locks.map((lock) => `${lock.status.padEnd(9)} ${lock.name} (${lock.kind}, @${lock.level})`);
  lines.push(...report.diagnostics.map(formatDiagnostic));
  const count = (status: string) => report.locks.filter((lock) => lock.status === status).length;
  const { errors, warnings } = countBySeverity(report.diagnostics);
  const noted = warnings > 0 ? `; ${plural(warnings, "warning")}` : "";
  lines.push(
    errors > 0
      ? `lock: ${plural(errors, "error")}, nothing recorded${noted}.`
      : `lock: ${count("recorded")} recorded, ${count("extended")} extended, ${count("unchanged")} unchanged in ${report.file}${noted}.`,
  );
  return `${lines.join("\n")}\n`;
}
