import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import { parseDesignMdx } from "../src/mdx.ts";
import { CODES } from "../src/codes.ts";
import { checkDesigns, checkLinking, cli, contract, copyFixture, data, designFile, designProject, editFile, find, mdx, readFile, writeFile } from "./helpers.ts";

const block = (...lines: string[]) => ["```gherkin design", ...lines, "```", ""].join("\n");
const parse = (...lines: string[]) => parseDesignMdx(block(...lines), "design.mdx");
const codes = (...lines: string[]) => parse(...lines).diagnostics.map(diagnostic => diagnostic.code);
const rule = (carrier = "Port", id = "keeps-value") => ["Feature: Values", "  @" + carrier, "  Rule: " + id + " — Keeps the supplied value."];
const declaration = contract("Port", "run(value: string): string;");

/** @tests Cli */
describe("Gherkin designs", () => {
  /** @covers gherkin-format gherkin-compatibility */
  test("keeps authored Gherkin separate from TypeScript and uses its Feature as context", (t) => {
    const gherkin = block(...rule(), "    Example: returns a value", '      Given the value "hello"', '      Then the result is "hello"');
    const source = "# Values\n\n" + gherkin + "```ts design\n" + declaration + "\n```\n";
    const parsed = parseDesignMdx(source, "design.mdx");
    assert.deepEqual(parsed.diagnostics, []);
    assert.equal(parsed.blocks.length, 1);
    assert.equal(parsed.blocks[0].lines.map(line => line.text).join("\n"), declaration);
    assert.equal(parsed.gherkin?.source, gherkin.trimEnd());
    assert.equal(parsed.hasBusinessContext, true);
    const root = designProject(t, { values: source });
    const checked = checkDesigns(root);
    assert.deepEqual(checked.diagnostics, []);
    assert.ok(!checked.modules[0].generated.text.includes("Feature:"));
    assert.equal(checked.index.invariants[0].text, "Keeps the supplied value.");
  });

  /** @covers gherkin-format */
  test("maps localized rules, tags, steps, tables and doc strings to CRLF MDX positions", () => {
    const source = ["# Valeurs", "", "```gherkin design", "# language: fr", "@Port", "Fonctionnalité: Valeurs", "  Contexte:", "    Soit les valeurs", "      | name | value |", "      | 😀 | deux |", "  @Property @Port.run", "  Règle: keeps-value - Préserve la valeur.", "    Contexte:", "      Soit une valeur", "    Exemple: du texte", "      Soit un document", '        """text/plain', "        exact text", '        """', "      Alors il reste intact", "```", ""].join("\r\n");
    // Two written carriers are reported, independently of the localized keywords.
    assert.deepEqual(parseDesignMdx(source, "design.mdx").diagnostics.map(item => item.code), ["E_RULE_UNBOUND"]);
    const valid = source.replace("@Property", "@property");
    const result = parseDesignMdx(valid, "design.mdx");
    assert.deepEqual(result.diagnostics, []);
    const feature = result.gherkin!.feature;
    assert.equal(feature.language, "fr");
    const parsedRule = result.gherkin!.rules[0];
    assert.equal(parsedRule.property, true);
    assert.equal(parsedRule.carrier?.member, "run");
    assert.deepEqual(parsedRule.location, { file: "design.mdx", ...find(valid, "Règle:") });
    const cell = feature.children[0].background!.steps[0].dataTable!.rows[1].cells[1];
    assert.deepEqual(cell.location, { file: "design.mdx", ...find(valid, "deux") });
    assert.equal(parsedRule.node.children[0].background!.steps[0].text, "une valeur");
    assert.equal(parsedRule.examples[0].steps[0].docString!.content, "exact text");
    assert.deepEqual(parsedRule.examples[0].steps[1].location, { file: "design.mdx", ...find(valid, "Alors") });
    const astral = block("Feature: Values", "  @Port.𝒜 @Other", "  Rule: one — A promise");
    const tags = parseDesignMdx(astral, "design.mdx").gherkin!.rules[0].node.tags;
    assert.deepEqual(tags[1].location, { file: "design.mdx", ...find(astral, "@Other") });
  });

  /** @covers gherkin-format */
  test("retains outline rows, descriptions, labels and escaped table values without expanding cases", () => {
    const result = parse(...rule(), "    @fast", "    Scenario Outline: keeps <value>", "      Describes the input.", '      Given a "<value>"', "        | field | value |", "        | text | a\\|b |", "      Then it remains", "      @small", "      Examples: inputs", "        | value |", "        | one |", "        | two |", "      Examples: more", "        | value |", "        | three |");
    assert.deepEqual(result.diagnostics, []);
    const example = result.gherkin!.rules[0].examples[0];
    assert.equal(result.gherkin!.rules[0].examples.length, 1);
    assert.equal(example.name, "keeps <value>");
    assert.match(example.description, /Describes the input/);
    assert.equal(example.tags[0].name, "@fast");
    assert.equal(example.steps[0].dataTable!.rows[1].cells[1].value, "a|b");
    assert.deepEqual(example.examples.map(table => table.tableBody.length), [2, 1]);
  });

  /** @covers gherkin-format */
  test("reports syntax at the authored location and rejects missing, duplicate, empty and nested blocks", () => {
    const source = "# Title\n\n" + block("Feature: Broken", "  Background:", "    Given rows", "      | a | b |", "      | one |");
    const result = parseDesignMdx(source, "design.mdx");
    assert.equal(result.diagnostics[0].code, "E_GHERKIN_SYNTAX");
    assert.equal(result.diagnostics[0].line, find(source, "| one |").line);
    assert.equal(result.diagnostics[0].column, find(source, "| one |").column);
    assert.deepEqual(codes("# just a comment"), ["E_GHERKIN_SYNTAX"]);
    assert.deepEqual(codes(), ["E_DESIGN_BLOCK_EMPTY"]);
    assert.deepEqual(codes("# language: does-not-exist", "Feature: Broken"), ["E_GHERKIN_SYNTAX"]);
    assert.deepEqual(parseDesignMdx(block(...rule()) + block(...rule()), "design.mdx").diagnostics.map(item => item.code), ["E_GHERKIN_SYNTAX"]);
    for (const source of ["> ```gherkin design\n> Feature: Nested\n> ```", "  ```gherkin design\n  Feature: Indented\n  ```"]) {
      assert.deepEqual(parseDesignMdx(source, "design.mdx").diagnostics.map(item => item.code), ["E_DESIGN_BLOCK_LOCATION"]);
    }
    assert.deepEqual(codes("Feature: Bad table", "  Background:", "    Given rows", "      | a | b |", "      | one |"), ["E_GHERKIN_SYNTAX"]);
    const unfinished = block("Feature: Rules", "  @Port");
    const eof = parseDesignMdx(unfinished, "design.mdx").diagnostics[0];
    assert.equal(eof.code, "E_GHERKIN_SYNTAX");
    assert.equal(eof.line, unfinished.trimEnd().split("\n").length);
    assert.equal(eof.column, 1);
  });

  /** @covers gherkin-carriers */
  test("requires a rule id and sentence, one carrier, and distinct nonempty example titles", () => {
    for (const name of ["no separator", "Wrong-id — A promise", "bad--id — A promise", "id — "]) {
      assert.deepEqual(codes("Feature: Rules", "  @Port", "  Rule: " + name), ["E_RULE_FORMAT"]);
    }
    assert.deepEqual(codes("Feature: Rules", "  Rule: one — A promise"), ["E_RULE_UNBOUND"]);
    assert.deepEqual(codes("Feature: Rules", "  @Port @Other", "  Rule: one — A promise"), ["E_RULE_UNBOUND"]);
    assert.deepEqual(codes("@Port @Other", "Feature: Rules", "  Rule: one — A promise", "  Rule: two — Another promise"), ["E_RULE_UNBOUND"]);
    assert.deepEqual(codes(...rule(), "    Example: Same title", "      Then yes", "    Scenario: same   TITLE", "      Then no"), ["E_EXAMPLE_DUPLICATE"]);
    assert.deepEqual(codes(...rule(), "    Example:", "      Then yes"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes(...rule(), "    Example: first", "      Then yes", "  @Port", "  Rule: second — Another promise", "    Example: first", "      Then yes"), []);
  });

  /** @covers gherkin-carriers gherkin-flags */
  test("inherits a Feature carrier, permits Rule overrides, and leaves assumptions unbound", () => {
    const result = parse("@Port", "Feature: Rules", "  Rule: first — One promise", "  @Other.run @property", "  Rule: second — Another promise", "  @assumption", "  Rule: outside — The provider exposes a title");
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.gherkin!.rules.map(rule => rule.carrier?.contract ?? null), ["Port", "Other", null]);
    assert.equal(result.gherkin!.rules[2].assumption, true);
    for (const tags of ["@assumption @Port", "@assumption @property"]) assert.deepEqual(codes("Feature: Rules", "  " + tags, "  Rule: outside — External fact"), ["E_RULE_UNBOUND"]);
    assert.ok(codes(...rule(), "  @property @property", "  Rule: second — A promise").includes("E_TAG_FORMAT"));
  });

  /** @covers gherkin-format gherkin-carriers gherkin-flags */
  test("rejects unsupported enforcement and placement instead of silently accepting it", () => {
    for (const tag of ["@final", "@extendable", "@live", "@tests", "@invariant"]) {
      assert.ok(codes("Feature: Rules", "  @Port " + tag, "  Rule: first — A promise").includes("E_GHERKIN_UNSUPPORTED"), tag);
    }
    assert.deepEqual(codes("Feature: Rules", "  @final", "  Rule: first — A promise"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes("@final", "Feature: Rules", "  Rule: first — A promise"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes("Feature: Rules", "  Scenario: outside a rule", "    Then yes"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes(...rule(), "    @Other", "    Example: wrong carrier", "      Then yes"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes(...rule(), "    Scenario Outline: empty", "      Then yes"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes(...rule(), "    Scenario Outline: empty table", "      Then yes", "      Examples:", "        | value |"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes(...rule(), "    Scenario: not an outline", "      Then yes", "      Examples:", "        | value |", "        | one |"), ["E_GHERKIN_UNSUPPORTED"]);
    assert.deepEqual(codes("@property", "Feature: Rules", "  @Port", "  Rule: first — A promise"), ["E_GHERKIN_UNSUPPORTED"]);
  });

  /** @covers gherkin-carriers */
  test("binds only contracts, families and existing members of the same module", (t) => {
    const cases = ["Missing", "Other", "Payload", "Port.missing"];
    for (const carrier of cases) {
      const source = block(...rule(carrier)) + mdx(declaration, data("Payload"));
      const root = designProject(t, { own: source, other: mdx(contract("Other", "run(): void;", "@invariant own A promise.")) });
      const result = checkDesigns(root);
      assert.deepEqual(result.errors.map(item => item.code), ["E_RULE_UNBOUND"], carrier);
      assert.deepEqual({ line: result.errors[0].line, column: result.errors[0].column }, find(source, "@" + carrier));
    }
  });

  /** @covers gherkin-carriers */
  test("shares ids across JSDoc, Gherkin, all members and documents of a contract", (t) => {
    const legacy = contract("Port", "run(): void; other(): void;", "@invariant keeps-value Legacy promise.");
    const root = designProject(t, { own: block(...rule("Port.run")) + mdx(legacy) });
    assert.deepEqual(checkDesigns(root).errors.map(item => item.code), ["E_INVARIANT_DUPLICATE"]);
    writeFile(root, designFile("own"), block(...rule("Port.run")) + mdx(contract("Port", "run(): void; other(): void;")));
    writeFile(root, "src/own/second.cage.mdx", block(...rule("Port.other")));
    const result = checkDesigns(root);
    assert.deepEqual(result.errors.map(item => item.code), ["E_INVARIANT_DUPLICATE"]);
    assert.equal(result.errors[0].related?.[0].file, designFile("own"));
  });

  /** @covers gherkin-inheritance gherkin-flags */
  test("inherits family examples through diamonds, binds inherited members and indexes assumptions separately", (t) => {
    const base = block(...rule("Family.run"), "    Example: one value", "      Then it remains", "  @assumption", "  Rule: outside — The provider exposes a field") + mdx(contract("Family", "run(value: string): string;").replace("@contract", "@family"));
    const child = block(...rule("Child.run", "local")) + mdx('import type { Family } from "../base/base.cage.mdx";', contract("Left", "").replace("@contract", "@family").replace("interface Left", "interface Left extends Family"), contract("Right", "").replace("@contract", "@family").replace("interface Right", "interface Right extends Family"), contract("Child", "").replace("interface Child", "interface Child extends Left, Right"));
    const root = designProject(t, { base, child });
    const result = checkDesigns(root);
    assert.deepEqual(result.diagnostics, []);
    const rules = result.index.invariants.filter(rule => rule.contract === "Child");
    assert.deepEqual(rules.map(rule => rule.id), ["local", "keeps-value"]);
    assert.equal(rules[1].inheritedFrom?.contract, "Family");
    assert.equal(rules[1].gherkin!.examples[0].name, "one value");
    assert.equal(rules[1].location.file, designFile("base"));
    assert.equal(result.index.assumptions?.length, 1);
    assert.equal(result.index.assumptions![0].rule.id, "outside");
    assert.ok(!result.index.invariants.some(rule => rule.id === "outside"));
    editFile(root, designFile("child"), text => text.replace("local —", "keeps-value —"));
    assert.deepEqual(checkDesigns(root).errors.map(item => item.code), ["E_INVARIANT_DUPLICATE"]);
  });

  /** @covers gherkin-inheritance */
  test("existing contract locks include own and inherited Gherkin promises", (t) => {
    const source = block(...rule("Base"), "  @Child", "  Rule: child-rule — A child promise.") + mdx(contract("Base", "run(): void;", "@final").replace("@contract", "@family"), contract("Child", "", "@final").replace("interface Child", "interface Child extends Base"));
    const root = designProject(t, { own: source });
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.index.locked.find(item => item.name === "Child")!.invariants, { "child-rule": "A child promise.", "keeps-value": "Keeps the supplied value." });
    assert.equal(cli(root, "lock").code, 0);
    editFile(root, designFile("own"), text => text.replace("Keeps the supplied value.", "Changes the supplied value."));
    const checked = cli(root, "check", "--phase", "design", "--format", "json");
    assert.equal(checked.code, 1);
    assert.equal(JSON.parse(checked.stdout).diagnostics.filter((item: { code: string }) => item.code === "E_LOCK_VIOLATION").length, 2);
  });

  /** @covers gherkin-format gherkin-carriers gherkin-inheritance */
  test("synthetic removal fixture has real implementations, child test links and passing runnable tests", (t) => {
    const root = copyFixture(t, "gherkin");
    const result = checkLinking(root);
    assert.deepEqual(result.errors, []);
    assert.equal(result.index!.contracts.filter(contract => contract.family).length, 1);
    assert.equal(result.linking.implementations.length, 4);
    for (const name of ["RemoveCourses", "RemoveEducation"]) {
      assert.equal(result.index!.invariants.filter(rule => rule.contract === name).length, 1);
      assert.ok(result.linking.tests.some(test => test.contract === name && test.covers.includes("match-required")));
    }
    const ran = spawnSync(process.execPath, ["--test", "src/removal.test.ts"], { cwd: root, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stdout + ran.stderr);
    const compiled = spawnSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", root], { encoding: "utf8" });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const legacyRoot = copyFixture(t, "gherkin");
    fs.mkdirSync(path.join(legacyRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules/typescript-5"), path.join(legacyRoot, "node_modules/typescript"), "dir");
    const legacyCompiler = checkLinking(legacyRoot);
    assert.equal(legacyCompiler.typescript.version, "5.9.3");
    assert.deepEqual(legacyCompiler.errors, []);
  });

  /** @covers gherkin-inheritance */
  test("Gherkin families retain rejected direct bindings and ambiguous child coverage", (t) => {
    const root = copyFixture(t, "gherkin");
    editFile(root, "src/removal.ts", text => text.replace("@implements RemoveCourses", "@implements RemoveSection"));
    assert.ok(checkLinking(root).errors.some(item => item.code === "E_FAMILY_BINDING"));
    editFile(root, "src/removal.ts", text => text.replace("@implements RemoveSection", "@implements RemoveCourses"));
    editFile(root, "src/removal.test.ts", text => text.replace("@tests RemoveCourses", "@tests RemoveCourses RemoveEducation"));
    assert.ok(checkLinking(root).errors.some(item => item.code === "E_REFERENCE_AMBIGUOUS"));
  });

  /** @covers gherkin-compatibility */
  test("unchanged legacy projects retain 0.11 diagnostics and recorded review fingerprints", (t) => {
    const root = copyFixture(t, "vertical");
    const stable = path.resolve("node_modules/cage-legacy/dist/cli.js");
    const runStable = (...args: string[]) => spawnSync(process.execPath, [stable, ...args, "--root", root], { encoding: "utf8" });
    // Establish synthetic review records with the pinned CLI before comparing unchanged material.
    // The named packet command supplies full material and current fingerprints.
    const names = checkDesigns(root).index.contracts.map(contract => contract.name);
    const full = JSON.parse(runStable("review", ...names, "--format", "json").stdout);
    const verdicts = { version: 1, verdicts: full.contracts.map((contract: { contract: string; fingerprint: string; invariants: { id: string }[] }) => ({ contract: contract.contract, fingerprint: contract.fingerprint, findings: (contract.invariants.length ? contract.invariants.map(rule => rule.id) : [null]).map(id => ({ invariant: id, assessment: "adequate", reason: "Compatibility fixture record.", evidence: "test fixture", suggestedChange: null })) })) };
    writeFile(root, "verdicts.json", JSON.stringify(verdicts));
    const recorded = runStable("review", "--record", path.join(root, "verdicts.json"));
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    const before = readFile(root, ".cage/review.json");
    const expected = runStable("check", "--format", "json");
    const actual = cli(root, "check", "--format", "json");
    assert.equal(actual.code, expected.status);
    assert.equal(actual.stdout, expected.stdout);
    assert.equal(readFile(root, ".cage/review.json"), before);
    assert.ok(!JSON.parse(actual.stdout).diagnostics.some((item: { code: string }) => item.code === "W_REVIEW_STALE"));
  });

  /** @covers gherkin-format */
  test("Gherkin checks are deterministic and new errors have explanatory codes", (t) => {
    const root = designProject(t, { own: block(...rule()) + mdx(declaration) });
    const first = cli(root, "check", "--phase", "design", "--format", "json");
    const second = cli(root, "check", "--phase", "design", "--format", "json");
    assert.equal(first.code, 0);
    assert.equal(first.stdout, second.stdout);
    for (const code of ["E_GHERKIN_SYNTAX", "E_GHERKIN_UNSUPPORTED", "E_RULE_FORMAT", "E_RULE_UNBOUND", "E_EXAMPLE_DUPLICATE"]) assert.ok(CODES[code]?.means && CODES[code]?.then);
    assert.equal(fs.existsSync(path.join(root, "src/own/.cage/design.ts")), false);
  });
});
