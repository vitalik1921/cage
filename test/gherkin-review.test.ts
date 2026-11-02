import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { defaultConfig, loadConfig } from "../src/config.ts";
import { exampleTitleMatches } from "../src/example-links.ts";
import { gherkinSegments, rulePacket } from "../src/gherkin-review.ts";
import { parseDesignMdx } from "../src/mdx.ts";
import type { ReviewReport } from "../src/review.ts";
import { cli, contract, copyFixture, designProject, editFile, mdx, readFile, writeFile } from "./helpers.ts";

const design = "src/removal.cage.mdx";
const tests = "src/removal.test.ts";
const names = ["EntryPicker", "EditorCheck", "RemoveCourses", "RemoveEducation"];
const block = (...lines: string[]) => ["```gherkin design", ...lines, "```", ""].join("\n");
function review(root: string, selected = names, included = "changed"): ReviewReport {
  const result = cli(root, "review", ...selected, "--files", included, "--format", "json");
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const report: ReviewReport = JSON.parse(result.stdout);
  assert.equal(report.complete, true, JSON.stringify(report.diagnostics));
  return report;
}
function record(root: string, selected = names) {
  const report = review(root, selected);
  writeFile(root, "verdict.json", JSON.stringify({ version: 1, verdicts: report.contracts.map(packet => ({
    contract: packet.contract, fingerprint: packet.fingerprint, findings: packet.invariants.map(invariant => ({
      invariant: invariant.id, assessment: "adequate", reason: "Synthetic review baseline for freshness tests.", evidence: `${invariant.tests[0].file}:${invariant.tests[0].line}`, suggestedChange: null,
    })),
  })) }));
  const result = cli(root, "review", "--record", "verdict.json");
  assert.equal(result.code, 0, result.stderr + result.stdout);
  return report;
}
const policies = (root: string, examples: string) => writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, examples, review: "off" }));
const checked = (root: string) => JSON.parse(cli(root, "check", "--format", "json").stdout) as { diagnostics: { code: string; contract?: string; invariant?: string; line?: number }[] };

/** @tests Cli */
describe("Gherkin Example links and reviews", () => {
  /** @covers example-links example-policy gherkin-inheritance */
  test("active title links remain concrete-child and rule scoped; policies only affect Gherkin", t => {
    const root = copyFixture(t, "gherkin");
    policies(root, "require");
    assert.deepEqual(checked(root).diagnostics, []);
    // A same-title declaration of the sibling child cannot provide this child's link.
    editFile(root, tests, source => source.replace('it("a two-letter match is refused"', 'it.skip("a two-letter match is refused"'));
    const errors = checked(root).diagnostics;
    assert.deepEqual(errors.map(item => [item.code, item.contract, item.invariant]), [["E_EXAMPLE_UNLINKED", "RemoveCourses", "match-required"]]);
    policies(root, "warn");
    assert.deepEqual(checked(root).diagnostics.map(item => item.code), ["W_EXAMPLE_UNLINKED"]);
    policies(root, "off");
    assert.deepEqual(checked(root).diagnostics, []);
    policies(root, "require");
    editFile(root, design, source => source.replace(/    Example: two equal titles\n[\s\S]*?(?=  @EntryPicker)/, ""));
    assert.ok(checked(root).diagnostics.some(item => item.code === "E_RULE_WITHOUT_EXAMPLE"));
    editFile(root, design, source => source.replace('  Rule: title-tie-refused', '  @property\n  Rule: title-tie-refused'));
    assert.ok(!checked(root).diagnostics.some(item => item.code.includes("RULE_WITHOUT_EXAMPLE")));
    const legacy = copyFixture(t, "vertical"); policies(legacy, "require");
    assert.ok(!checked(legacy).diagnostics.some(item => /EXAMPLE/.test(item.code)));
  });

  /** @covers example-templates */
  test("outline and it.each placeholders normalize without stripping ordinary literal titles", () => {
    const source = block("Feature: Values", "  @Port", "  Rule: keeps — Keeps values.", "    Scenario Outline:  KEEPS <x>  ", "      Then the value stays", "      Examples:", "        | x |", "        | a |");
    const example = parseDesignMdx(source, "a.mdx").gherkin!.rules[0].examples[0];
    for (const title of ["keeps $x", "keeps $value.name", ...["s", "d", "i", "f", "j", "o", "#", "%"].map(token => `keeps %${token}`), " keeps \t $x %d "]) {
      assert.equal(exampleTitleMatches(example, { title, each: true }), true, title);
    }
    assert.equal(exampleTitleMatches(example, { title: "keeps $x" }), false);
    assert.equal(exampleTitleMatches({ ...example, examples: [] }, { title: "keeps", each: true }), false);
    assert.equal(exampleTitleMatches(example, { title: "loses %s", each: true }), false);
  });

  /** @covers gherkin-review-packet gherkin-review-touched */
  test("verbatim examples and touched digests retain the last step at an unclosed fence's EOF", () => {
    for (const fence of ["```", "~~~~", "````"]) for (const close of [false, true]) {
      const source = [fence + "gherkin design", "Feature: Values", "  @Port", "  Rule: keeps — Keeps values.", "    Example: a value", "      Then the last assertion stays", ...(close ? [fence] : [])].join("\r\n");
      const parsed = parseDesignMdx(source, "value.mdx");
      assert.deepEqual(parsed.diagnostics, []);
      const design = parsed.gherkin!;
      const rule = design.rules[0];
      const packet = rulePacket({ contract: "Port", id: rule.id, text: rule.text, member: null, location: rule.location, gherkin: rule }, [], design);
      assert.ok(packet.examples[0].source.endsWith("Then the last assertion stays"));
      assert.ok(gherkinSegments(design).rules["Port.keeps"].endsWith("Then the last assertion stays"));
    }
  });

  /** @covers example-links example-policy */
  test("title normalization never grants links to inactive, broken or wrongly tagged tests", t => {
    const root = designProject(t, { values: block("Feature: Values", "  @Port", "  Rule: keeps — Keeps values.", "    Example: keeps a value", "      Then it stays", "  @property", "  @Port", "  Rule: returns — Returns a value.") + mdx(contract("Port", "(value: string): string;")) }, {
      "src/values/code.ts": '/** @implements Port */\nexport function keep(value: string): string { return value; }',
    });
    policies(root, "require");
    const active = 'import { it } from "node:test";\nimport { keep } from "./code.ts";\n/** @tests Port\n * @covers keeps returns */\nit("  KEEPS   a VALUE  ", () => { if (keep("x") !== "x") throw Error("changed"); });';
    const file = "src/values/code.test.ts";
    writeFile(root, file, active);
    assert.deepEqual(checked(root).diagnostics, []);
    for (const source of [active.replace('it("', 'it.skip("'), active.replace('it("', 'it.todo("'), active.replace('if (keep("x") !== "x") throw Error("changed");', ''), 'import { missing } from "./absent.ts";\n' + active, active.replace("@covers keeps returns", "@covers returns")]) {
      writeFile(root, file, source);
      assert.ok(checked(root).diagnostics.some(item => item.code === "E_EXAMPLE_UNLINKED"));
    }
    writeFile(root, file, active.replace("@covers keeps returns", "@covers: keeps returns"));
    const rejected = checked(root).diagnostics;
    assert.ok(rejected.some(item => item.code === "E_TAG_FORMAT"));
    assert.ok(!rejected.some(item => item.code === "E_EXAMPLE_UNLINKED"));
  });

  /** @covers example-templates example-links gherkin-review-packet */
  test("the adapter retains it.each templates and the packet links them without expanding rows", t => {
    const root = designProject(t, { values: block("Feature: Values", "  @Port", "  Rule: keeps — Keeps values.", "    Scenario Outline: keeps <x>", "      Then <x> stays", "      Examples:", "        | x |", "        | a |", "        | b |") + mdx(contract("Port", "(value: string): string;")) }, {
      "src/values/code.ts": '/** @implements Port */\nexport function keep(value: string): string { return value; }',
      "node_modules/vitest/package.json": '{"name":"vitest","version":"0.0.0","types":"index.d.ts"}',
      "node_modules/vitest/index.d.ts": 'export declare const it: { each(rows: readonly unknown[]): (title: string, fn: (value: string) => void) => void };',
      "src/values/code.test.ts": 'import { it } from "vitest";\nimport { keep } from "./code.ts";\n/** @tests Port\n * @covers keeps */\nit.each(["a"])("keeps $x %s", value => { if (keep(value) !== value) throw Error("changed"); });',
      ".cage/config.json": '{"version":1,"testAdapter":"vitest","examples":"require","review":"off"}',
    });
    assert.deepEqual(checked(root).diagnostics, []);
    const packet = review(root, ["Port"]).contracts[0];
    assert.equal(packet.invariants[0].gherkin!.examples[0].tests[0].title, "keeps $x %s");
    assert.equal(packet.tests[0].declarations.length, 1);
    assert.ok(packet.invariants[0].gherkin!.examples[0].source.includes("| b |"), "missing runtime row does not erase authored cases or their title link");
  });

  /** @covers gherkin-review-touched gherkin-review-material */
  test("editing only an Example stales the carrier and touches only its rule", t => {
    const root = copyFixture(t, "gherkin"); record(root);
    const before = readFile(root, ".cage/review.json");
    editFile(root, design, source => source.replace('Then the first entry is selected by title', 'Then the first entry is selected by title\n      And the second entry is preserved'));
    const report = review(root);
    const picker = report.contracts.find(packet => packet.contract === "EntryPicker")!;
    assert.equal(picker.recordedReview.status, "outdated");
    assert.deepEqual(picker.touched, ["exact-title-wins"]);
    assert.deepEqual(picker.invariants.filter(rule => rule.touched).map(rule => rule.id), ["exact-title-wins"]);
    for (const other of report.contracts.filter(packet => packet !== picker)) {
      assert.equal(other.recordedReview.status, "outdated", "whole module prose remains material");
      assert.deepEqual(other.touched, []);
    }
    assert.equal(readFile(root, ".cage/review.json"), before, "reading never rewrites the baseline");
    const index = JSON.parse(cli(root, "review", "--format", "json").stdout);
    assert.deepEqual(index.contracts.find((packet: { contract: string }) => packet.contract === "EntryPicker").touched, ["exact-title-wins"]);
  });

  /** @covers gherkin-review-touched gherkin-review-material */
  test("Feature context, Background, assumptions, glossary and other module prose touch every contract", t => {
    const root = copyFixture(t, "gherkin"); record(root);
    const original = readFile(root, design);
    for (const [from, to] of [
      ["The caller removes", "The platform removes"],
      ["Given the supported sections", "Given the available sections"],
      ["The external site renders", "The external provider renders"],
      ["text with no letter", "text with no adjacent letter"],
    ]) {
      writeFile(root, design, original.replace(from, to));
      for (const packet of review(root).contracts) {
        assert.equal(packet.recordedReview.status, "outdated", from);
        assert.deepEqual(packet.touched, packet.invariants.map(rule => rule.id), from);
      }
    }
    writeFile(root, design, original);
    writeFile(root, "src/context.cage.mdx", "# Context\n\nA second document still matters.\n");
    for (const packet of review(root).contracts) assert.deepEqual(packet.touched, packet.invariants.map(rule => rule.id));
  });

  /** @covers gherkin-review-touched */
  test("rule backgrounds touch the document, while a linked-test edit touches only its rule", t => {
    const root = copyFixture(t, "gherkin");
    editFile(root, design, source => source.replace('    Example: the exact title among lookalikes', '    Background:\n      Given a readable list\n    Example: the exact title among lookalikes'));
    record(root);
    const original = readFile(root, design);
    editFile(root, design, source => source.replace("Given a readable list", "Given a complete readable list"));
    for (const packet of review(root).contracts) assert.deepEqual(packet.touched, packet.invariants.map(rule => rule.id));
    writeFile(root, design, original);
    editFile(root, tests, source => source.replace('pick(null, "marker 9971")', 'pick(null, "marker 9982")'));
    const report = review(root);
    assert.deepEqual(report.contracts.find(packet => packet.contract === "EntryPicker")!.touched, ["unreadable-list"]);
    for (const other of report.contracts.filter(packet => packet.contract !== "EntryPicker")) assert.equal(other.recordedReview.status, "current");
  });

  /** @covers gherkin-review-packet example-links */
  test("packets pair verbatim Examples, list gaps, and share authored contexts once", t => {
    const root = copyFixture(t, "gherkin");
    editFile(root, tests, source => source.replace('it("two equal titles"', 'it("two equal titles renamed"'));
    const report = review(root);
    assert.equal(report.gherkin!.length, 1);
    const parsed = parseDesignMdx(readFile(root, design), design).gherkin!;
    assert.equal(report.gherkin![0].source, parsed.source);
    const picker = report.contracts.find(packet => packet.contract === "EntryPicker")!;
    const linked = picker.invariants.find(rule => rule.id === "exact-title-wins")!.gherkin!;
    assert.equal(linked.examples[0].tests[0].title, "the exact title among lookalikes");
    assert.ok(readFile(root, design).includes(linked.examples[0].source));
    const gap = picker.invariants.find(rule => rule.id === "title-tie-refused")!.gherkin!;
    assert.deepEqual(gap.unlinkedExamples, ["two equal titles"]);
    assert.deepEqual(gap.unmatchedTests.map(test => test.title), ["two equal titles renamed"]);
    const markdown = cli(root, "review", ...names).stdout;
    assert.equal(markdown.split("@assumption").length - 1, 1);
    assert.equal(markdown.split("  Background:").length - 1, 1);
    assert.ok(markdown.includes(parsed.source));
    assert.ok(markdown.includes('unlinked Examples: "two equal titles"'));
    assert.ok(markdown.includes("rule-linked tests without an Example: T"));
    assert.equal(cli(root, "review", ...names, "--format", "json").stdout, cli(root, "review", ...names, "--format", "json").stdout);
    for (const mode of ["all", "context"]) assert.equal(review(root, names, mode).gherkin!.length, 1);
    assert.equal(review(root, names, "none").gherkin, undefined);
  });

  /** @covers gherkin-review-material gherkin-review-touched */
  test("old Gherkin records stay current without new hints and fall back to all touched after edits", t => {
    const root = copyFixture(t, "gherkin"); record(root);
    editFile(root, ".cage/review.json", source => {
      const value = JSON.parse(source);
      for (const entry of value.reviews) delete entry.gherkin;
      return JSON.stringify(value);
    });
    const old = readFile(root, ".cage/review.json");
    for (const packet of review(root).contracts) assert.equal(packet.recordedReview.status, "current");
    assert.equal(readFile(root, ".cage/review.json"), old);
    editFile(root, design, source => source.replace("Then the first entry is selected by title", "Then only the first entry is selected by title"));
    for (const packet of review(root).contracts) assert.deepEqual(packet.touched, packet.invariants.map(rule => rule.id));
  });

  /** @covers gherkin-review-material gherkin-review-touched gherkin-inheritance */
  test("an inherited Gherkin document and its assumptions remain material of each child", t => {
    const root = copyFixture(t, "gherkin");
    const original = readFile(root, design);
    const begin = original.indexOf("  @RemoveSection\n");
    const end = original.indexOf("```", begin);
    const rules = original.slice(begin, end);
    editFile(root, design, source => source.slice(0, begin) + source.slice(end));
    editFile(root, design, source => source.replace('/** @family\n * @description A removal capability sharing the input guard. */\nexport interface RemoveSection {}', 'import type { RemoveSection } from "./family/base.cage.mdx";'));
    writeFile(root, "src/family/base.cage.mdx", block("Feature: Shared guard", rules.trimEnd()) + mdx('/** @family\n * @description A shared guard. */\nexport interface RemoveSection {}'));
    record(root, ["RemoveCourses", "RemoveEducation"]);
    editFile(root, "src/family/base.cage.mdx", source => source.replace("And the page receives no calls", "And the page receives no calls at all"));
    for (const packet of review(root, ["RemoveCourses", "RemoveEducation"]).contracts) {
      assert.equal(packet.recordedReview.status, "outdated");
      assert.deepEqual(packet.touched, ["match-required"]);
    }
    record(root, ["RemoveCourses", "RemoveEducation"]);
    editFile(root, "src/family/base.cage.mdx", source => source.replace("external site", "external provider"));
    for (const packet of review(root, ["RemoveCourses", "RemoveEducation"]).contracts) assert.equal(packet.recordedReview.status, "outdated");
  });
});

/** @tests ConfigLoader
 * @covers defaults fields */
test("examples defaults to warn, accepts each policy and rejects misspellings", t => {
  const root = copyFixture(t, "gherkin");
  assert.equal(defaultConfig.examples, "warn");
  for (const policy of ["off", "warn", "require"]) {
    policies(root, policy);
    assert.equal(loadConfig(root).config.examples, policy);
    assert.deepEqual(loadConfig(root).diagnostics, []);
  }
  policies(root, "error");
  assert.equal(loadConfig(root).diagnostics[0].code, "E_CONFIG");
});
