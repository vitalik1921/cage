import type { Diagnostic, RelatedLocation } from "./diagnostic.ts";
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

export function formatExtractReport(report: ExtractReport): string {
  const lines = report.outputs.map((output) => `${output.status.padEnd(9)} ${output.path}`);
  lines.push(...report.diagnostics.map(formatDiagnostic));

  const count = (status: string) => report.outputs.filter((output) => output.status === status).length;
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const command = report.checkOnly ? "extract --check" : "extract";
  if (errors > 0) {
    const written = count("written");
    lines.push(`${command}: ${errors} ${errors === 1 ? "error" : "errors"}${written > 0 ? `, ${written} written` : report.checkOnly ? "" : ", nothing written"}.`);
  } else if (report.checkOnly) {
    lines.push(`${command}: ${report.outputs.length} generated ${report.outputs.length === 1 ? "file is" : "files are"} current.`);
  } else {
    lines.push(`${command}: ${count("written")} written, ${count("unchanged")} unchanged.`);
  }
  return `${lines.join("\n")}\n`;
}
