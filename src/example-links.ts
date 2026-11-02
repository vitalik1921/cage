import type { DesignIndex, Invariant, TestDeclaration } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { normalizeExampleTitle, type GherkinExample } from "./gherkin.ts";
import type { RejectedLink } from "./test-declarations.ts";

/** Remove template slots only in the constructs that interpolate them. No rows are executed or counted. */
export function exampleTitleMatches(example: GherkinExample, test: Pick<TestDeclaration, "title" | "each">): boolean {
  const exampleTitle = example.examples.length > 0 ? example.name.replace(/<[^<>\r\n]+>/gu, "") : example.name;
  const testTitle = test.each ? test.title.replace(/\$[\p{ID_Start}_][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_][\p{ID_Continue}$]*)*|%[sdifjo#%]/gu, "") : test.title;
  return normalizeExampleTitle(exampleTitle) === normalizeExampleTitle(testTitle);
}

/** Links stay scoped to the concrete contract and rule, even for inherited family examples. */
export function examplesOf(invariant: Invariant, tests: readonly TestDeclaration[]) {
  const candidates = tests.filter(test => test.contract === invariant.contract && test.covers.includes(invariant.id));
  const examples = (invariant.gherkin?.examples ?? []).map(example => ({
    example,
    tests: candidates.filter(test => test.status === "active" && exampleTitleMatches(example, test)),
  }));
  return { examples, unmatchedTests: candidates.filter(test => !examples.some(example => example.tests.includes(test))) };
}

export function checkExampleLinks(index: DesignIndex, tests: readonly TestDeclaration[], rejected: readonly RejectedLink[], policy: "off" | "warn" | "require"): Diagnostic[] {
  if (policy === "off") return [];
  const families = new Set(index.contracts.filter(contract => contract.family).map(contract => contract.name));
  const diagnostics: Diagnostic[] = [];
  const codes = { EXAMPLE_UNLINKED: ["W_EXAMPLE_UNLINKED", "E_EXAMPLE_UNLINKED"], RULE_WITHOUT_EXAMPLE: ["W_RULE_WITHOUT_EXAMPLE", "E_RULE_WITHOUT_EXAMPLE"] };
  const report = (code: keyof typeof codes, message: string, invariant: Invariant, location = invariant.location) => diagnostics.push({
    code: codes[code][policy === "require" ? 1 : 0], severity: policy === "require" ? "error" as const : "warning" as const,
    message, ...location, contract: invariant.contract, invariant: invariant.id,
  });
  for (const invariant of index.invariants) {
    if (!invariant.gherkin || families.has(invariant.contract)) continue;
    const { examples } = examplesOf(invariant, tests);
    if (examples.length === 0 && !invariant.gherkin.property) report("RULE_WITHOUT_EXAMPLE", `${invariant.contract}.${invariant.id}`, invariant);
    // A rejected binding already explains missing links; do not multiply its consequences.
    if (rejected.some(link => (link.contract === null || link.contract === invariant.contract) && (link.invariants === "all" || link.invariants.includes(invariant.id)))) continue;
    for (const { example, tests: linked } of examples) if (linked.length === 0) report("EXAMPLE_UNLINKED", `${invariant.contract}.${invariant.id}: ${example.name}`, invariant, { file: invariant.location.file, line: example.location.line, column: example.location.column ?? 1 });
  }
  return diagnostics;
}
