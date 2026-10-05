import type { CheckReport } from "./check.ts";
import { isError, type Diagnostic, type RelatedLocation } from "./diagnostic.ts";
import type { LockReport } from "./lock-command.ts";

function formatLocation({ file, line, column }: Pick<RelatedLocation, "file" | "line" | "column">): string {
  if (file === undefined) return "";
  return line === undefined ? `${file}: ` : `${file}:${line}:${column}: `;
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const code = diagnostic.tsCode === undefined ? diagnostic.code : `${diagnostic.code} TS${diagnostic.tsCode}`;
  const lines = [`${formatLocation(diagnostic)}${diagnostic.severity} ${code}: ${diagnostic.message.replaceAll("\n", "\n  ")}`];
  for (const related of diagnostic.related ?? []) lines.push(`  ${formatLocation(related)}${related.message.replaceAll("\n", "\n  ")}`);
  return lines.join("\n");
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function countBySeverity(diagnostics: readonly Diagnostic[]) {
  const errors = diagnostics.filter(isError).length;
  return { errors, warnings: diagnostics.length - errors };
}

export function formatCheckReport(report: CheckReport): string {
  const { counts, scope } = report;
  const { errors, warnings } = countBySeverity(report.diagnostics);
  const { version, source, fallbackReason } = scope.typescript;
  const compiler = `TypeScript ${version} (${fallbackReason === undefined ? source : `${source}; ${fallbackReason}`})`;
  const lines = report.diagnostics.map(formatDiagnostic);

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
        const reviews =
          counts.reviewedInvariants === null || counts.weakInvariants === null
            ? "reviews: not checked"
            : `reviews: ${counts.reviewedInvariants} attested adequate, ${counts.weakInvariants} found weak, ${counts.invariants - counts.reviewedInvariants - counts.weakInvariants} unreviewed${counts.weakContracts ? `, ${plural(counts.weakContracts, "contract")} found weak as a whole` : ""}`;
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
