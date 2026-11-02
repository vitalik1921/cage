import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { defaultLint } from "../src/lint-config.ts";
import { loadConfig } from "../src/config.ts";
import { cli, cliWithStdin, contract, copyFixture, data, designFile, designProject, editFile, find, mdx, readFile, snapshot, writeFile, QUOTA } from "./helpers.ts";

const lint = (root: string) => JSON.parse(cli(root, "check", "--phase", "lint", "--format", "json", "--max-diagnostics", "all").stdout) as CheckReport;
const codes = (root: string) => lint(root).diagnostics.map(diagnostic => diagnostic.code);
const gherkin = (...lines: string[]) => ["```gherkin design", "@Worker", "Feature: Work", ...lines, "```", ""].join("\n");
const spec = contract("Worker", "run(): void;", "@invariant works Work finishes.");
const configure = (root: string, lint: unknown) => writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, lint }));

/** @tests Cli */
describe("core design lint", () => {
  /** @covers lint-history */
  test("history recognizes explicit notation, hashes and configured patterns in prose and promises", t => {
    const source = ["# Work", "", "2026-02-11: changed the policy.", "", "User decision: retain requests.", "", "Commit a01b23c changed this.", "", "KI-731 was the incident.", "", mdx(contract("Worker", "run(): void;", "@invariant works Settled: work finishes.")), gherkin("  Rule: finish — Decided on 2026-02-10 to finish work.", "    A user decision defines this promise.")].join("\n");
    const root = designProject(t, { own: source });
    configure(root, { historyPatterns: ["KI-\\d+"] });
    const found = lint(root).diagnostics;
    assert.equal(found.length, 7, JSON.stringify(found));
    assert.ok(found.every(item => item.code === "W_HISTORY_REFERENCE" && item.severity === "warning"));
    assert.deepEqual({ line: found[0].line, column: found[0].column }, find(source, "2026-02-11:"));
    assert.deepEqual({ line: found[4].line, column: found[4].column }, find(source, "@invariant works"));
  });

  /** @covers lint-history */
  test("business dates and resolved sentences stay quiet; cases, tables and doc strings are excluded", t => {
    const source = ["# Dates", "", "The renewal is due on 2026-02-11.", "", "Resolved requests remain readable.", "", "A request is resolved when its answer is recorded.", "", "Current policy {/* user decision from old draft */} applies.", "", "| history | note |", "| --- | --- |", "| 2026-01-01: Settled: | user decision |", "", "date | note", "--- | ---", "user decision | Settled:", "", mdx(spec), gherkin(
      "  Background:", "    Given the user decision of 2026-01-01", '      | history |', '      | Settled: changed |',
      "  Rule: finish — Resolved work remains readable until 2027-01-01.",
      "    Example: user decision from 2026-02-11", "      Given user decision on 2026-02-11", '      """', "      # cage-lint-disable W_HISTORY_REFERENCE", "      Settled: historical test input", '      """',
      "      Then resolved requests remain readable", "        | value |", "        | user decision |",
    )].join("\n");
    const root = designProject(t, { own: source });
    assert.deepEqual(codes(root), []);
  });

  /** @covers lint-questions lint-numbering */
  test("settled questions and nonsequential numbering point at their authored items", t => {
    const source = mdx(spec) + "\n## Business rules\n1. Work finishes.\n3. Work remains available.\n\n## Open questions\n0. Resolved: use the queue.\n1a. Still undecided?\nb. Another question?\n";
    const root = designProject(t, { own: source });
    const found = lint(root).diagnostics;
    assert.deepEqual(found.map(item => item.code), ["W_NUMBERING", "W_NUMBERING", "W_OPEN_QUESTION_SETTLED"], JSON.stringify(found));
    assert.equal(found.find(item => item.code === "W_OPEN_QUESTION_SETTLED")?.line, find(source, "0. Resolved").line);
    writeFile(root, designFile("own"), mdx(spec) + "\n## Business rules\n1. Work finishes.\n2. Resolved requests remain readable.\n\n## Open questions\n1. Should we retain resolved requests?\n2. Which retention window?\n");
    assert.deepEqual(codes(root), []);
  });

  /** @covers lint-numbering lint-history lint-questions */
  test("nested case lists and code blocks do not affect section numbering; formatted statuses are visible", t => {
    const source = mdx(spec) + "\n## Business rules\n1. Work finishes.\n   1. One nested case.\n   2. Another nested case.\n2. Work remains readable.\n\n```text\n0. Example only.\n```\n\n## Open questions\n1. **Resolved:** retain requests.\n\n## Settled: old heading\n";
    const root = designProject(t, { own: source });
    const found = lint(root).diagnostics;
    assert.ok(!found.some(item => item.code === "W_NUMBERING"), JSON.stringify(found));
    assert.equal(found.filter(item => item.code === "W_HISTORY_REFERENCE").length, 1);
    assert.equal(found.filter(item => item.code === "W_OPEN_QUESTION_SETTLED").length, 1);
    const lines = cli(root, "check", "--phase", "lint").stdout.split("\n").filter(line => /^[EW]_/.test(line));
    const itemLine = find(source, "1. **Resolved").line;
    const headingLine = find(source, "## Settled").line;
    assert.deepEqual(lines, [
      `W_OPEN_QUESTION_SETTLED: settled Open question 1 (src/own/own.cage.mdx:${itemLine}:1)`,
      `W_HISTORY_REFERENCE: historical notation belongs in git or the review record (src/own/own.cage.mdx:${headingLine}:1)`,
    ]);
  });

  /** @covers lint-size */
  test("limits count authored concrete contracts, family members and mixed-format rules", t => {
    const family = contract("Base", "a(): void; b(): void;", "@invariant first First.", "@invariant second Second.").replace("@contract", "@family");
    const child = contract("Worker", "run(): void;", "@invariant works Work finishes.").replace("interface Worker {", "interface Worker extends Base {");
    const root = designProject(t, { own: mdx(family, child) + gherkin("  Rule: finish — Work ends.") });
    configure(root, { limits: { contractsPerModule: 0, membersPerContract: 1, rulesPerContract: 1 } });
    const found = lint(root).diagnostics;
    assert.deepEqual(found.map(item => item.code).sort(), ["W_CONTRACT_SIZE", "W_CONTRACT_SIZE", "W_MODULE_SIZE"]);
    assert.match(found.find(item => item.code === "W_MODULE_SIZE")!.message, /1 contracts/);
    assert.match(found.find(item => item.message.startsWith("Worker:"))!.message, /2 rules/);
    configure(root, { limits: { contractsPerModule: 1, membersPerContract: 2, rulesPerContract: 2 } });
    assert.deepEqual(codes(root), []);
    // The Gherkin block can be in another document of the same module.
    writeFile(root, designFile("own"), mdx(family, child));
    writeFile(root, "src/own/rules.cage.mdx", gherkin("  Rule: finish — Work ends."));
    configure(root, { limits: { rulesPerContract: 1 } });
    assert.ok(lint(root).diagnostics.some(item => item.code === "W_CONTRACT_SIZE" && item.message.startsWith("Worker: 2 rules")));
  });

  /** @covers lint-references */
  test("citations resolve locally, module-first and by a unique project stem; unknown and ambiguous targets warn", t => {
    const rules = "\n## Business rules\n1. Work finishes.\n";
    const root = designProject(t, { own: mdx(contract("Worker", "run(): void;", "@invariant works Work finishes (rule 1) (shared rule 1) (remote rule 1).")) + rules, elsewhere: mdx(data("Other")) });
    writeFile(root, "src/own/shared.cage.mdx", rules);
    writeFile(root, "src/elsewhere/shared.cage.mdx", rules);
    writeFile(root, "src/elsewhere/remote.cage.mdx", rules);
    assert.deepEqual(codes(root), []);
    editFile(root, designFile("own"), text => text.replace("(rule 1)", "(rule 9)").replace("(shared rule 1)", "(missing rule 1)"));
    writeFile(root, "src/own/remote.cage.mdx", "# No rules\n");
    assert.equal(codes(root).filter(code => code === "W_RULE_REFERENCE_UNKNOWN").length, 3);
    fs.rmSync(path.join(root, "src/own/remote.cage.mdx"));
    writeFile(root, "src/third/remote.cage.mdx", rules);
    assert.equal(codes(root).filter(code => code === "W_RULE_REFERENCE_UNKNOWN").length, 3);
  });

  /** @covers lint-questions lint-history lint-suppressions */
  test("settled question statuses have one diagnostic even when suppressed or disabled", t => {
    const root = designProject(t, { own: mdx(spec) + "\n## Open questions\n1. Settled: retain requests.\n" });
    configure(root, { historyPatterns: ["Settled"] });
    assert.deepEqual(codes(root), ["W_OPEN_QUESTION_SETTLED"]);
    editFile(root, designFile("own"), text => text.replace("1. Settled", "{/* cage-lint-disable W_OPEN_QUESTION_SETTLED: decision pending cleanup */}\n1. Settled"));
    assert.deepEqual(codes(root), []);
    configure(root, { severity: { W_OPEN_QUESTION_SETTLED: "off" } });
    assert.deepEqual(codes(root), ["W_LINT_SUPPRESSION_UNUSED"]);
    editFile(root, designFile("own"), text => text.replace("retain requests.", "user decision: retain requests."));
    assert.ok(codes(root).includes("W_HISTORY_REFERENCE"), "independent history in the same item remains visible");
  });

  /** @covers lint-references */
  test("plural lists check each number and stop before unrelated parenthetical text", t => {
    const rules = "\n## Business rules\n1. One.\n2. Two.\n3. Three.\n";
    const root = designProject(t, { own: mdx(contract("Worker", "run(): void;", "@invariant works Works (rules 3, 8), (rules 1, 2 and 5), (rule 1, KI-11), (add-once rules 1, 2).")) + rules });
    writeFile(root, "src/own/add-once.cage.mdx", rules);
    const found = lint(root).diagnostics;
    assert.deepEqual(found.map(item => item.code), ["W_RULE_REFERENCE_UNKNOWN", "W_RULE_REFERENCE_UNKNOWN"]);
    assert.ok(found.some(item => item.message.startsWith("(rule 8)")));
    assert.ok(found.some(item => item.message.startsWith("(rule 5)")));
    editFile(root, designFile("own"), text => text.replace("3, 8", "3, 2").replace("2 and 5", "2 and 3"));
    assert.deepEqual(codes(root), []);
    editFile(root, "src/own/add-once.cage.mdx", text => text.replace("2. Two.", ""));
    assert.ok(lint(root).diagnostics.some(item => item.message.startsWith("(add-once rule 2)")));
  });

  /** @covers lint-types */
  test("duplicate data names across modules include all locations; same-module declarations and different names do not warn", t => {
    const root = designProject(t, { a: mdx(data("Shared")), b: mdx(data("Shared")), c: mdx(data("Shared")) });
    const found = lint(root).diagnostics;
    assert.equal(found.length, 1);
    assert.equal(found[0].code, "W_TYPE_DUPLICATE");
    assert.equal(found[0].file, designFile("a"));
    assert.deepEqual(found[0].related?.map(item => item.file), [designFile("b"), designFile("c")]);
    writeFile(root, designFile("b"), mdx(data("Different")));
    writeFile(root, designFile("c"), mdx(spec));
    writeFile(root, "src/a/more.cage.mdx", mdx(data("Shared")));
    assert.deepEqual(codes(root), []);
  });

  /** @covers lint-suppressions lint-suppression-audit */
  test("MDX suppressions need a reason and affect only the next block and named code", t => {
    const source = "# Work\n\n{/* cage-lint-disable W_HISTORY_REFERENCE: incident is a business identifier */}\nUser decision: a historical heading.\n\nUser decision: still reported.\n\n{/* cage-lint-disable W_HISTORY_REFERENCE: unused now */}\nOrdinary business prose.\n\n{/* cage-lint-disable W_HISTORY_REFERENCE */}\n\n{/* cage-lint-disable W_HISTORY_REFERENCE:   */}\n\n{/* cage-lint-disable E_RULE_UNBOUND: cannot hide structure */}\n" + mdx(spec);
    const root = designProject(t, { own: source });
    const found = lint(root).diagnostics;
    assert.equal(found.filter(item => item.code === "W_HISTORY_REFERENCE").length, 1);
    assert.equal(found.find(item => item.code === "W_HISTORY_REFERENCE")?.line, find(source, "User decision: still").line);
    assert.equal(found.filter(item => item.code === "W_LINT_SUPPRESSION_UNUSED").length, 1);
    assert.equal(found.filter(item => item.code === "E_TAG_FORMAT").length, 3);
    configure(root, false);
    assert.deepEqual(codes(root), []);
  });

  /** @covers lint-suppressions lint-suppression-audit */
  test("Gherkin suppression uses real comments and the next Rule or Example, never later rules", t => {
    const root = designProject(t, { own: mdx(spec) + gherkin(
      "  # cage-lint-disable W_HISTORY_REFERENCE: reproduces the historical heading", "  Rule: first — Settled: first promise.",
      "    Example: one", "      Given input", "      Then output",
      "    # cage-lint-disable W_HISTORY_REFERENCE: case content is already excluded", "    Example: two", "      Given user decision", "      Then output",
      "  Rule: second — Settled: second promise.",
      "  # cage-lint-disable W_HISTORY_REFERENCE: no following rule",
    ) });
    const found = lint(root).diagnostics;
    assert.equal(found.filter(item => item.code === "W_HISTORY_REFERENCE").length, 1);
    assert.equal(found.filter(item => item.code === "W_LINT_SUPPRESSION_UNUSED").length, 2);
  });

  /** @covers lint-suppressions lint-suppression-audit */
  test("a local suppression can explain a grouped duplicate and duplicate/off-code directives are unused", t => {
    const root = designProject(t, { a: mdx(data("Shared")), b: "# B\n\n{/* cage-lint-disable W_TYPE_DUPLICATE: distinct external schemas */}\n" + mdx(data("Shared")).replace(/^[\s\S]*?```ts/, "```ts") });
    assert.deepEqual(codes(root), []);
    editFile(root, designFile("b"), source => source.replace("{/* cage-lint-disable", "{/* cage-lint-disable W_TYPE_DUPLICATE: duplicate directive */}\n{/* cage-lint-disable"));
    assert.deepEqual(codes(root), ["W_LINT_SUPPRESSION_UNUSED"]);
    configure(root, { severity: { W_TYPE_DUPLICATE: "off" } });
    assert.deepEqual(codes(root), ["W_LINT_SUPPRESSION_UNUSED", "W_LINT_SUPPRESSION_UNUSED"]);
  });

  /** @covers lint-phase */
  test("lint checks document syntax without reading tsconfig, implementations, tests, locks or reviews", t => {
    const root = designProject(t, { own: mdx(spec) }, { "tsconfig.json": "broken", ".cage/lock.json": "broken", ".cage/review.json": "broken", "src/own/code.ts": "broken implementation", "src/own/code.test.ts": "broken test" });
    const before = snapshot(root);
    assert.deepEqual(codes(root), []);
    assert.equal(lint(root).phase, "lint");
    assert.equal(lint(root).scope.compilerOptions, null);
    assert.equal(lint(root).counts.contracts, null);
    assert.equal(lint(root).counts.testDeclarations, null);
    assert.deepEqual(snapshot(root), before);
    assert.match(cli(root, "check", "--phase", "lint", "--base", "HEAD").stderr, /locks are not checked/);
    writeFile(root, designFile("own"), '```gherkin design\nFeature: Work\n  Rule: malformed\n```\n');
    assert.ok(codes(root).includes("E_RULE_FORMAT"));
    // Parse errors do not trigger a misleading unused-suppression audit.
    writeFile(root, designFile("own"), "{/* cage-lint-disable W_HISTORY_REFERENCE: pending syntax fix */}\n```gherkin design\nNot a Feature\n```\n");
    assert.deepEqual(codes(root), ["E_GHERKIN_SYNTAX"]);
  });

  /** @covers lint-policy */
  test("full check adds warnings even after structural failure; default gate ignores them and maxDiagnostics favors existing warnings", t => {
    const root = copyFixture(t, "vertical");
    editFile(root, QUOTA, text => text.replace("# Квота", "# Квота\n\nUser decision: retain reservations."));
    const full = cli(root, "check", "--format", "json");
    assert.equal(full.code, 0, full.stdout);
    const report = JSON.parse(full.stdout) as CheckReport;
    assert.equal(report.diagnostics.at(-1)?.code, "W_HISTORY_REFERENCE");
    const limited = JSON.parse(cli(root, "check", "--format", "json", "--max-diagnostics", "1").stdout) as CheckReport;
    assert.notEqual(limited.diagnostics[0].code, "W_HISTORY_REFERENCE");
    assert.equal(limited.omitted.byCode.W_HISTORY_REFERENCE, 1);
    assert.deepEqual(cliWithStdin(root, JSON.stringify({ session_id: "lint-test", stop_hook_active: false }), "gate"), { code: 0, stdout: "", stderr: "" });
    configure(root, { severity: { W_HISTORY_REFERENCE: "error" } });
    const raised = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
    assert.equal(raised.ok, false);
    assert.equal(raised.diagnostics.find(item => item.code === "W_HISTORY_REFERENCE")?.severity, "error");
    const gate = cli(root, "gate");
    assert.equal(gate.code, 2);
    assert.match(gate.stderr, /W_HISTORY_REFERENCE/);
    configure(root, {});
    editFile(root, QUOTA, text => text.replace("export interface Quota", "export interface BrokenQuota"));
    const broken = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
    assert.ok(broken.diagnostics.some(item => item.severity === "error"));
    assert.ok(broken.diagnostics.some(item => item.code === "W_HISTORY_REFERENCE"));
  });

  /** @covers lint-policy */
  test("lint false preserves 0.11 text, JSON, diagnostics and review records byte for byte", t => {
    const root = copyFixture(t, "vertical");
    editFile(root, QUOTA, text => text.replace("# Квота", "# Квота\n\nUser decision: retain reservations.\n\n{/* cage-lint-disable W_HISTORY_REFERENCE */}"));
    const stable = (...args: string[]) => spawnSync(process.execPath, [path.resolve("node_modules/cage-legacy/dist/cli.js"), ...args, "--root", root], { encoding: "utf8" });
    writeFile(root, ".cage/config.json", JSON.stringify({ version: 1 }));
    const names = ["Quota", "Sender", "Send"];
    const full = JSON.parse(stable("review", ...names, "--format", "json").stdout);
    assert.ok(full.contracts.length);
    writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts: full.contracts.map((packet: { contract: string; fingerprint: string; invariants: { id: string }[] }) => ({ contract: packet.contract, fingerprint: packet.fingerprint, findings: (packet.invariants.length ? packet.invariants.map(rule => rule.id) : [null]).map(invariant => ({ invariant, assessment: "adequate", reason: "Synthetic compatibility record.", evidence: "fixture", suggestedChange: null })) })) }));
    const recorded = stable("review", "--record", path.join(root, "verdicts.json"));
    assert.equal(recorded.status, 0, recorded.stdout + recorded.stderr);
    const review = readFile(root, ".cage/review.json");
    const config = readFile(root, ".cage/config.json");
    for (const args of [["check"], ["check", "--format", "json"], ["check", "--phase", "design", "--format", "json"], ["review", "--all", "--format", "json"]]) {
      writeFile(root, ".cage/config.json", config);
      const expected = stable(...args);
      writeFile(root, ".cage/config.json", JSON.stringify({ ...JSON.parse(config), lint: false }));
      const actual = cli(root, ...args);
      assert.equal(actual.code, expected.status);
      assert.equal(actual.stdout, expected.stdout, args.join(" "));
      assert.equal(actual.stderr, expected.stderr);
    }
    assert.equal(readFile(root, ".cage/review.json"), review);
    assert.doesNotMatch(cli(root, "check").stdout, /REVIEW_STALE/);
  });

  /** @covers lint-phase lint-history lint-numbering */
  test("source positions survive CRLF and non-BMP text, and TS5/TS6 output is deterministic", t => {
    const source = ("# 🐝 Work\n\nUser decision: changed.\n\n## Open questions\n2. Pending?\n\n" + mdx(spec)).replaceAll("\n", "\r\n");
    let expected: unknown;
    for (const compiler of ["typescript-5", "typescript"]) {
      const root = designProject(t, { own: source });
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
      const first = cli(root, "check", "--phase", "lint", "--format", "json");
      assert.equal(first.stdout, cli(root, "check", "--phase", "lint", "--format", "json").stdout);
      const found = (JSON.parse(first.stdout) as CheckReport).diagnostics;
      assert.equal(found.length, 2);
      assert.deepEqual({ line: found[0].line, column: found[0].column }, find(source, "User decision"));
      if (expected) assert.deepEqual(found, expected);
      expected = found;
    }
  });
});

/** @tests ConfigLoader
 * @covers defaults fields */
test("lint configuration validates every key, limit, severity and regular expression", t => {
  const root = designProject(t, { own: mdx(spec) });
  for (const invalid of [true, null, [], { enabled: true }, { severity: { E_TAG_FORMAT: "off" } }, { severity: { W_HISTORY_REFERENCE: "require" } }, { limits: { methodsPerContract: 5 } }, { limits: { rulesPerContract: -1 } }, { limits: { rulesPerContract: 1.2 } }, { historyPatterns: ["["] }, { historyPatterns: [""] }, { historyPatterns: [1] }]) {
    configure(root, invalid);
    assert.equal(cli(root, "check", "--phase", "lint").code, 2, JSON.stringify(invalid));
    assert.ok(loadConfig(root).diagnostics.every(item => item.code === "E_CONFIG"));
  }
  configure(root, { limits: { membersPerContract: 9 }, severity: { W_NUMBERING: "off" }, historyPatterns: ["INC-\\d+"] });
  const loaded = loadConfig(root);
  assert.deepEqual(loaded.diagnostics, []);
  assert.deepEqual(loaded.config.lint, { ...defaultLint, limits: { ...defaultLint.limits, membersPerContract: 9 }, severity: { W_NUMBERING: "off" }, historyPatterns: ["INC-\\d+"] });
});
