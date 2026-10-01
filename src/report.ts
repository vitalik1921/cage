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
        facts.push(
          plural(counts.implementations, "implementation"),
          plural(counts.testDeclarations, "test declaration"),
          `${counts.linkedInvariants} of ${plural(counts.invariants, "invariant")} linked to a test declaration`,
        );
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
