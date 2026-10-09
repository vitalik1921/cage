import type { CheckReport } from "./check.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { formatDiagnostic, formatOmitted, limitCheckReport, plural } from "./report.ts";

/** A literal excerpt, never an inferred diagnosis or a rewritten reviewer recommendation. */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 360 ? flat : `${flat.slice(0, 360).replace(/\s+\S*$/, "")}… [excerpt]`;
}

function changesOf(diagnostic: Diagnostic): string[] {
  const changes = diagnostic.review?.changes;
  if (!changes) return ["Recorded material changed; inspect the review packet."];
  if (changes.length === 0) return ["The fingerprint changed without a differing material part; inspect the review packet."];
  const groups = new Map<string, { action: string; kind: string; file: string; count: number }>();
  for (const { part, change } of changes) {
    const match = /^(test|implementation|dependency|design) (.*)$/s.exec(part);
    const kind = match?.[1] ?? "contract";
    const rest = match?.[2] ?? "";
    const file = kind === "test" ? rest.slice(0, rest.indexOf(":")) : kind === "implementation" ? rest.slice(0, rest.lastIndexOf("#")) : rest;
    const action = { changed: "Changed", new: "Added", gone: "Removed" }[change];
    const key = JSON.stringify([action, kind, file]);
    const group = groups.get(key) ?? { action, kind, file, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  const all = [...groups.values()].map(({ action, kind, file, count }) => `${action}: ${plural(count, kind === "design" ? "design text" : kind === "contract" ? "contract declaration" : kind, kind === "dependency" ? "dependencies" : undefined)}${file ? ` in ${file}` : ""}.`);
  return all.length <= 4 ? all : [...all.slice(0, 4), `${all.length - 4} more change groups; see the review packet.`];
}

function reviewCommand(contract: string): string {
  // Contract names are normally identifiers; keep unusual names literal in a shell too.
  const word = /^[A-Za-z_][A-Za-z0-9_]*$/.test(contract) ? contract : `'${contract.replaceAll("'", "'\\''")}'`;
  return `cage review ${word}`;
}

function block(diagnostic: Diagnostic): string {
  const { code, contract } = diagnostic;
  if (!/^E_REVIEW_(STALE|MISSING|WEAK)$/.test(code) || !contract) return formatDiagnostic(diagnostic);
  const head = formatDiagnostic({ ...diagnostic, related: undefined, message: diagnostic.message.split("\n")[0] });
  let details: string[];
  if (code === "E_REVIEW_STALE") details = [...changesOf(diagnostic), "Review the changes:"];
  else if (code === "E_REVIEW_MISSING") details = ["No recorded review. Review the contract:"];
  else {
    const finding = diagnostic.review?.finding;
    details = [
      finding ? `Recorded finding: ${excerpt(finding.reason)}` : "Read the recorded finding in the review packet.",
      finding?.assessment === "insufficient-context"
        ? "Next: provide the missing evidence, then review again."
        : "Next: read the full finding, fix the implementation or test as needed, then review again.",
      "Full finding and review material:",
    ];
  }
  return [head, ...details.map(line => `  ${line}`), `    ${reviewCommand(contract)}${code === "E_REVIEW_WEAK" ? " --files context" : ""}`].join("\n");
}

/** The report already contains only blockers. Counts include diagnostics hidden by the display limit. */
export function formatGateReport(report: CheckReport, max: number | "all", released = false): string {
  const counts = new Map<string, number>();
  for (const { code } of report.diagnostics) counts.set(code, (counts.get(code) ?? 0) + 1);
  const categories = [
    ["E_REVIEW_STALE", "outdated review"], ["E_REVIEW_MISSING", "missing review"], ["E_REVIEW_WEAK", "weak finding"],
  ];
  const summary = categories.filter(([code]) => counts.has(code)).map(([code, label]) => plural(counts.get(code)!, label));
  const reviews = categories.reduce((sum, [code]) => sum + (counts.get(code) ?? 0), 0);
  if (report.diagnostics.length > reviews) summary.push(plural(report.diagnostics.length - reviews, "other error"));
  const limited = limitCheckReport(report, max);
  const lines = [`cage gate: ${released ? "unresolved" : "blocked"} — ${summary.join(", ")}`, ...limited.diagnostics.map(block), ...formatOmitted(limited)];
  if (reviews > 0) {
    lines.push("After reviewing, record the verdicts:\n  cage review --record <file>");
    // Group discovery remains useful when several contracts share changed dependencies.
    if ((counts.get("E_REVIEW_STALE") ?? 0) > 1) lines.push("For shared changes, cage review lists grouped review commands.");
    if (report.diagnostics.some(d => d.code === "E_REVIEW_STALE" && !d.contract)) lines.push("For records of deleted contracts, cage review lists remaining work; recording verdicts also removes obsolete records.");
    lines.push("Do not lower assessments, drop invariants or change .cage/config.json just to pass.");
  }
  if (report.diagnostics.length > reviews) lines.push("Fix the reported errors; cage codes explains each code.");
  lines.push("cage reads tests; it does not run them.");
  return `${lines.join("\n\n")}\n`;
}
