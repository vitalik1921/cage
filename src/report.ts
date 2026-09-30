import type { CheckReport } from "./check.ts";
import { isError, type Diagnostic, type RelatedLocation } from "./diagnostic.ts";
import type { ExtractReport } from "./extract.ts";

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

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function countBySeverity(diagnostics: readonly Diagnostic[]) {
  const errors = diagnostics.filter(isError).length;
  return { errors, warnings: diagnostics.length - errors };
}

export function formatExtractReport(report: ExtractReport): string {
  const lines = report.outputs.map((output) => `${output.status.padEnd(9)} ${output.path}`);
  lines.push(...report.diagnostics.map(formatDiagnostic));

  const count = (status: string) => report.outputs.filter((output) => output.status === status).length;
  const { errors, warnings } = countBySeverity(report.diagnostics);
  const command = report.checkOnly ? "extract --check" : "extract";
  const noted = warnings > 0 ? `; ${plural(warnings, "warning")}` : "";
  if (errors > 0) {
    const written = count("written");
    lines.push(`${command}: ${plural(errors, "error")}${written > 0 ? `, ${written} written` : report.checkOnly ? "" : ", nothing written"}${noted}.`);
  } else if (report.checkOnly) {
    lines.push(`${command}: ${report.outputs.length} generated ${report.outputs.length === 1 ? "file is" : "files are"} current${noted}.`);
  } else {
    lines.push(`${command}: ${count("written")} written, ${count("unchanged")} unchanged${noted}.`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatCheckReport(report: CheckReport): string {
  const { counts, scope } = report;
  const { errors, warnings } = countBySeverity(report.diagnostics);
  const { version, source, fallbackReason } = scope.typescript;
  const compiler = `TypeScript ${version} (${fallbackReason === undefined ? source : `${source}; ${fallbackReason}`})`;
  const lines = report.diagnostics.map(formatDiagnostic);
  // Without an index there is nothing to count: an earlier error stopped the check.
  const indexed =
    counts.contracts === null || counts.data === null || counts.invariants === null
      ? "contracts not indexed"
      : `${plural(counts.contracts, "contract")}, ${plural(counts.data, "data type")}, ${plural(counts.invariants, "invariant")}`;
  lines.push(
    `check --phase ${report.phase}: ${plural(scope.designFiles.length, "design")}, ${indexed}; ${plural(errors, "error")}, ${plural(warnings, "warning")}. ${compiler}.`,
  );
  return `${lines.join("\n")}\n`;
}
