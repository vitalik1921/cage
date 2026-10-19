import type { CheckReport } from "./check.ts";
import { compareText, isError, type Diagnostic, type RelatedLocation } from "./diagnostic.ts";
import type { LockReport } from "./lock-command.ts";

function formatPlace({ file, line, column }: Pick<RelatedLocation, "file" | "line" | "column">): string {
  if (file === undefined) return "";
  return line === undefined ? file : `${file}:${line}:${column}`;
}

/**
 * One diagnostic as text: `CODE: what (file:line:column)` — the code says what kind of thing it is, the message names
 * the thing, the place closes the line; a message's further lines (a list, a compiler's explanation) follow indented.
 * Related places follow as `what (file:line:column)`. The severity is the code's prefix; what a code means and what
 * to do about it is `cage codes`, not the line.
 */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  const place = [formatPlace(diagnostic), diagnostic.tsCode === undefined ? "" : `TS${diagnostic.tsCode}`].filter((part) => part !== "").join(", ");
  const [head, ...details] = diagnostic.message.split("\n");
  const lines = [`${diagnostic.code}: ${head}${place === "" ? "" : ` (${place})`}`, ...details.map((text) => `  ${text}`)];
  for (const related of diagnostic.related ?? []) {
    const where = formatPlace(related);
    lines.push(`  ${related.message.replaceAll("\n", "\n  ")}${where === "" ? "" : ` (${where})`}`);
  }
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
 * Diagnostics that share a proven cause (`cause.id`, with the same code and severity), each set in the order of its
 * first member; every other diagnostic is a group of its own. Nothing is merged on text.
 */
export function groupDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[][] {
  const groups: Diagnostic[][] = [], byCause = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const key = diagnostic.cause && JSON.stringify([diagnostic.code, diagnostic.severity, diagnostic.cause.id]);
    const group = key === undefined ? undefined : byCause.get(key);
    if (group) group.push(diagnostic);
    else {
      groups.push([diagnostic]);
      if (key !== undefined) byCause.set(key, groups[groups.length - 1]);
    }
  }
  return groups;
}

type Omitted = CheckReport["omitted"];

/** At most `max` items, the ones that matter most, in their order; the diagnostics of the rest counted by code. */
function limitItems<T>(items: readonly T[], max: number | "all", members: (item: T) => readonly Diagnostic[]): { shown: T[]; omitted: Omitted } {
  if (max === "all") return { shown: [...items], omitted: { limit: null, count: 0, errors: 0, warnings: 0, byCode: {} } };
  const ordered = items.map((item, index) => ({ item, index, rank: rank(members(item)[0]) })).sort((a, b) => a.rank - b.rank || a.index - b.index);
  const shown = ordered.slice(0, max).sort((a, b) => a.index - b.index).map(({ item }) => item);
  const left = ordered.slice(max).flatMap(({ item }) => members(item));
  const counted = new Map<string, number>();
  for (const { code } of left) counted.set(code, (counted.get(code) ?? 0) + 1);
  const { errors, warnings } = countBySeverity(left);
  return { shown, omitted: { limit: max, count: left.length, errors, warnings, byCode: sortedCounts(counted) } };
}

const sortedCounts = (counted: Map<string, number>) => Object.fromEntries([...counted].sort(([codeA, a], [codeB, b]) => b - a || compareText(codeA, codeB)));

/** What two limits left out together: the report's own `omitted` and what a further limit on its diagnostics adds. */
function addOmitted(earlier: Omitted, later: Omitted): Omitted {
  const counted = new Map(Object.entries(earlier.byCode));
  for (const [code, count] of Object.entries(later.byCode)) counted.set(code, (counted.get(code) ?? 0) + count);
  return { limit: later.limit ?? earlier.limit, count: earlier.count + later.count, errors: earlier.errors + later.errors, warnings: earlier.warnings + later.warnings, byCode: sortedCounts(counted) };
}

/**
 * The report with at most `max` diagnostics, the ones that matter most, in the order of the report; what is left out is
 * counted in `omitted`, by code. `ok` and the counts stay those of the whole check: a limit changes what is shown, not
 * what was found.
 */
export function limitCheckReport(report: CheckReport, max: number | "all"): CheckReport {
  if (max === "all") return report;
  const { shown, omitted } = limitItems(report.diagnostics, max, (diagnostic) => [diagnostic]);
  return { ...report, omitted, diagnostics: shown };
}

/**
 * The groups text shows: at most `max` groups (a single diagnostic is one), ranked as diagnostics are; `omitted` counts
 * every diagnostic of the groups left out.
 */
export function limitGroups(diagnostics: readonly Diagnostic[], max: number | "all"): { groups: Diagnostic[][]; omitted: Omitted } {
  const { shown, omitted } = limitItems(groupDiagnostics(diagnostics), max, (group) => group);
  return { groups: shown, omitted };
}

/** The line that stands for the diagnostics a limit left out: how many, of which codes, and how to see them. */
export function formatOmitted({ omitted }: { omitted: Omitted }): string[] {
  if (omitted.count === 0) return [];
  const codes = Object.entries(omitted.byCode).map(([code, count]) => `${count} ${code}`).join(", ");
  return [`${omitted.count} more not shown (${codes}); --max-diagnostics all shows every one`];
}

const formatPlaces = (places: Pick<RelatedLocation, "file" | "line" | "column">[]) => {
  const text = places.map(formatPlace).filter((place) => place !== "");
  return text.length ? ` (${text.join("; ")})` : "";
};

/**
 * Diagnostics with one proven cause: the code and the shared explanation once, then each affected subject at its place,
 * with its contracts at theirs. A group of one is the diagnostic itself.
 */
export function formatGroup(group: readonly Diagnostic[], single: (diagnostic: Diagnostic) => string = formatDiagnostic): string {
  const [first] = group;
  if (group.length === 1 || !first.cause) return group.map(single).join("\n");
  const lines = [`${first.code}: ${first.cause.summary} — ${group.length} diagnostics:`];
  for (const diagnostic of group) {
    const { subject, contracts } = diagnostic.cause!;
    // The producer lists the contracts and their places (related) in the same order.
    const related = diagnostic.related ?? [];
    const named = contracts.map((name, index) => `${name}${related[index] ? formatPlaces([related[index]]) : ""}`);
    const rest = related.slice(contracts.length).map((place) => `${place.message.split("\n")[0]}${formatPlaces([place])}`);
    lines.push(`  ${subject}${formatPlaces([diagnostic])}${[...named, ...rest].length ? ` → ${[...named, ...rest].join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

/**
 * The report as text. `max` bounds groups of diagnostics with one proven cause (a single diagnostic is one), ranked as
 * diagnostics are; pass the whole report with the limit. A report already limited by `limitCheckReport` keeps its own
 * `omitted`, to which a further limit adds.
 */
export function formatCheckReport(report: CheckReport, max: number | "all" = "all"): string {
  const { counts, scope } = report;
  const limited = limitGroups(report.diagnostics, max);
  const groups = limited.groups;
  const omitted = addOmitted(report.omitted, limited.omitted);
  const shown = groups.flat();
  // The counts are of the whole check: a limit on what is shown changes nothing here.
  const errors = countBySeverity(shown).errors + omitted.errors;
  const warnings = countBySeverity(shown).warnings + omitted.warnings;
  const { version, source, fallbackReason } = scope.typescript;
  const compiler = `TypeScript ${version} (${fallbackReason === undefined ? source : `${source}; ${fallbackReason}`})`;
  const lines = [...groups.map((group) => formatGroup(group)), ...formatOmitted({ omitted })];

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
