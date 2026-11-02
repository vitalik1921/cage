import type { Invariant, TestDeclaration } from "./design-model.ts";
import type { GherkinDesign, GherkinRule } from "./gherkin.ts";
import { examplesOf } from "./example-links.ts";

/** Extra comparison data, not a replacement for the complete document fingerprint. */
export type GherkinDigests = Record<string, { context: string; rules: Record<string, string> }>;

const firstLine = (node: { location: { line: number }; tags: readonly { location: { line: number } }[] }) => Math.min(node.location.line, ...node.tags.map(tag => tag.location.line));
export const ruleKey = (rule: GherkinRule) => `${rule.carrier?.contract}.${rule.id}`;

/** CommonMark also permits a fence to run to EOF; its last content line must not disappear. */
function contentEnd(lines: readonly string[]): number {
  const fence = /^(`{3,}|~{3,})/.exec(lines[0])![1];
  const closing = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`);
  return closing.test(lines.at(-1)!) ? lines.length - 1 : lines.length;
}

/** Keep every authored byte in either context or a rule, with normalized checkout line endings. */
export function gherkinSegments(design: GherkinDesign): { context: string; rules: Record<string, string> } {
  const lines = design.source.replace(/\r\n?/g, "\n").split("\n");
  const rules: Record<string, string> = {};
  const context: string[] = [];
  let at = 0;
  design.rules.forEach((rule, index) => {
    const start = firstLine(rule.node) - design.location.line;
    const end = index + 1 < design.rules.length ? firstLine(design.rules[index + 1].node) - design.location.line : contentEnd(lines);
    context.push(...lines.slice(at, start));
    const text = lines.slice(start, end).join("\n");
    if (rule.assumption) context.push(text);
    else {
      rules[ruleKey(rule)] = text;
      context.push(`[Gherkin rule ${ruleKey(rule)}]`);
      for (const [childIndex, child] of rule.node.children.entries()) {
        if (!child.background) continue;
        const next = rule.node.children[childIndex + 1];
        const last = next?.scenario ? firstLine(next.scenario) - design.location.line : end;
        context.push(lines.slice(child.background.location.line - design.location.line, last).join("\n"));
      }
    }
    at = end;
  });
  context.push(...lines.slice(at));
  return { context: context.join("\n"), rules };
}

export function rulePacket(invariant: Invariant, tests: readonly TestDeclaration[], design: GherkinDesign) {
  const rule = invariant.gherkin!;
  const lines = design.source.replace(/\r\n?/g, "\n").split("\n");
  const ref = (test: TestDeclaration) => ({ ...test.location, title: test.title, status: test.status });
  const linked = examplesOf(invariant, tests);
  const ruleIndex = design.rules.indexOf(rule);
  // Inherited invariants retain the authored rule object.
  const nextRule = design.rules[ruleIndex + 1];
  const end = nextRule ? firstLine(nextRule.node) - design.location.line : contentEnd(lines);
  return {
    flags: rule.node.tags.map(tag => tag.name),
    examples: linked.examples.map(({ example, tests }, index) => {
      const start = firstLine(example) - design.location.line;
      const next = rule.examples[index + 1];
      return { title: example.name, location: { file: invariant.location.file, line: example.location.line, column: example.location.column ?? 1 },
        source: lines.slice(start, next ? firstLine(next) - design.location.line : end).join("\n"), tests: tests.map(ref) };
    }),
    unlinkedExamples: linked.examples.filter(example => example.tests.length === 0).map(({ example }) => example.name),
    unmatchedTests: linked.unmatchedTests.map(ref),
  };
}

/** Malformed optional hints are ignored: they can never make a record current or change its verdict. */
export function isGherkinDigests(value: unknown): value is GherkinDigests {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(entry => entry && typeof entry === "object" && typeof entry.context === "string" && entry.rules && typeof entry.rules === "object" && !Array.isArray(entry.rules) && Object.values(entry.rules).every(digest => typeof digest === "string"));
}
