import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { createDraft } from "../src/draft.ts";
import { digestOf, draftPathOf, parseDraft } from "../src/draft-file.ts";
import { parseDesignMdx } from "../src/mdx.ts";
import type { MigrationReport } from "../src/migrate.ts";
import { cli, contract, copyFixture, designFile, designProject, editFile, mdx, QUOTA, readFile, snapshot, writeFile, checkDesigns } from "./helpers.ts";

const migrate = (root: string, ...args: string[]): MigrationReport => JSON.parse(cli(root, "migrate", "gherkin", ...args, "--format", "json").stdout);
const candidate = (root: string, target: string) => {
  const parsed = parseDraft(readFile(root, draftPathOf(target)));
  assert.ok(!("problem" in parsed));
  return parsed;
};
const ruleSet = (source: string, file: string) => parseDesignMdx(source, file).gherkin!.rules.filter(rule => rule.carrier).map(rule => ({ carrier: rule.carrier!.contract + (rule.carrier!.member ? "." + rule.carrier!.member : ""), id: rule.id, text: rule.text }));

/** @tests Cli */
describe("migration through drafts", () => {
  /** @covers migrate-preserves migrate-mixed migrate-drafts migrate-repeat */
  test("several contracts retain whole-contract, method and multiline promises, with existing Gherkin intact", t => {
    const existing = '```gherkin design\n@Worker\nFeature: Work\n  Background:\n    Given a queue\n  Rule: existing — Existing work finishes.\n    Example: one job\n      When it runs\n      Then it finishes\n  @assumption\n  Rule: service-ready — The external service is ready.\n```\n';
    const source = '# Work\n\n## Purpose\n\nPerform queued work.\n\n' + existing + mdx(`/**
 * @contract
 * @description Work service.
 * @invariant whole Queued work
 *   remains available until it finishes.
 * @see Queue policy
 */
export interface Worker {
  /**
   * @invariant once A job runs once.
   * @description Runs one job.
   */
  run(): void;
  /** @invariant stopped A stopped job stays stopped. */
  stop(): void;
}
/**
 * @contract
 * @description Another service.
 * @invariant whole Other work finishes.
 */
export interface Other {
  /** @invariant callable Calling returns. */
  (): void;
}`) + '\n## Open questions\n1. Which queue?\n';
    const root = designProject(t, { own: source });
    const before = snapshot(root);
    const report = migrate(root, "src/own");
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.equal(report.files[0].status, "created");
    assert.equal(report.files[0].rules, 5);
    const draft = candidate(root, designFile("own"));
    assert.equal(draft.base, digestOf(source));
    assert.equal(readFile(root, designFile("own")), source);
    assert.ok(draft.content.includes(existing.slice(0, -4)), "existing authored rules, examples and assumptions remain verbatim");
    assert.ok(draft.content.includes(" * @see Queue policy"));
    assert.ok(draft.content.includes(" * @description Runs one job."));
    assert.ok(draft.content.endsWith("## Open questions\n1. Which queue?\n"));
    assert.doesNotMatch(draft.content, /@invariant/);
    assert.deepEqual(ruleSet(draft.content, designFile("own")), [
      { carrier: "Worker", id: "existing", text: "Existing work finishes." },
      { carrier: "Worker", id: "whole", text: "Queued work remains available until it finishes." },
      { carrier: "Worker.run", id: "once", text: "A job runs once." },
      { carrier: "Worker.stop", id: "stopped", text: "A stopped job stays stopped." },
      { carrier: "Other", id: "whole", text: "Other work finishes." },
      { carrier: "Other", id: "callable", text: "Calling returns." },
    ]);
    assert.equal(cli(root, "draft", "check", draftPathOf(designFile("own"))).code, 0);
    for (const [file, text] of Object.entries(before)) assert.equal(readFile(root, file), text, file);
    assert.deepEqual(Object.keys(snapshot(root)).filter(file => !(file in before)), [draftPathOf(designFile("own"))]);
    const written = snapshot(root);
    assert.equal(migrate(root, "src/own").files[0].status, "unchanged");
    assert.deepEqual(snapshot(root), written);
  });

  /** @covers migrate-preview migrate-preserves migrate-mixed migrate-layout */
  test("dry-run previews deterministic changes, retaining CRLF/BOM prose once with a title-only Feature after the H1", t => {
    const source = '\ufeff# Queue\r\n\r\n## Purpose\r\n\r\nRun **queued** work.\r\nKeep it available.\r\n\r\nA second paragraph.\r\n\r\n' + mdx(contract("Worker", "run(): void;", "@invariant once A job runs once.")).replaceAll("\n", "\r\n");
    const root = designProject(t, { own: source });
    const before = snapshot(root);
    const first = cli(root, "migrate", "gherkin", "src/own", "--dry-run");
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.equal(first.stdout, cli(root, "migrate", "gherkin", "src/own", "--dry-run").stdout);
    assert.match(first.stdout, /--- a\/src\/own\/own.cage.mdx/);
    assert.match(first.stdout, /\+  Rule: once — A job runs once\./);
    assert.match(first.stdout, /- \* @invariant once/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(migrate(root, "src/own").ok, true);
    const draft = candidate(root, designFile("own"));
    assert.ok(draft.content.startsWith("# Queue\r\n\r\n```gherkin design\r\nFeature: Queue\r\n\r\n"));
    assert.equal(draft.content.split("Run **queued** work.").length, 2);
    assert.ok(draft.content.indexOf("```gherkin design") < draft.content.indexOf("## Purpose"));
    assert.equal(parseDesignMdx(draft.content, designFile("own")).gherkin?.feature.description, "");
    assert.ok(draft.content.includes("A second paragraph.\r\n"));
    assert.doesNotMatch(draft.content, /(?<!\r)\n/);
    assert.equal(readFile(root, designFile("own")), source);
  });

  /** @covers migrate-layout migrate-preserves */
  test("new Features precede sections with setext or absent document headings", t => {
    for (const title of ["Queue\n=====\n\n", ""]) {
      const source = title + "## Contracts\n\n```ts design\n" + contract("Worker", "run(): void;", "@invariant once Runs once.") + "\n```\n";
      const root = designProject(t, { own: source });
      assert.equal(migrate(root, "src/own").ok, true);
      const { content } = candidate(root, designFile("own"));
      assert.ok(content.indexOf("```gherkin design") < content.indexOf("## Contracts"));
      assert.ok(content.startsWith(title || "```gherkin design"));
      assert.equal(parseDesignMdx(content, designFile("own")).gherkin?.feature.name, title ? "Queue" : "own");
      assert.equal(cli(root, "draft", "check", draftPathOf(designFile("own"))).code, 0);
    }
  });

  /** @covers migrate-conflict migrate-drafts */
  test("an edited draft refuses the whole selection before other drafts are written", t => {
    const root = designProject(t, { a: mdx(contract("A", "run(): void;", "@invariant once Runs once.")), b: mdx(contract("B", "run(): void;", "@invariant once Runs once.")) });
    assert.equal(migrate(root, "src/b").ok, true);
    editFile(root, draftPathOf(designFile("b")), text => text + "\nA person's edit.\n");
    const before = snapshot(root);
    for (const args of [[], ["--dry-run"]]) {
      const report = migrate(root, "src/a", "src/b", ...args);
      assert.equal(report.ok, false);
      assert.ok(report.diagnostics.some(item => item.code === "E_DRAFT_CONFLICT"));
      assert.deepEqual(snapshot(root), before);
    }
  });

  /** @covers migrate-repeat migrate-conflict */
  test("unchanged designs need no draft, stale bases and preexisting copy drafts are refused", t => {
    const root = designProject(t, { own: mdx(contract("Worker", "run(): void;", "@invariant once Runs once.")) });
    assert.equal(cli(root, "draft", "create", designFile("own")).code, 0);
    const copy = snapshot(root);
    assert.equal(migrate(root, "src/own").ok, false);
    assert.deepEqual(snapshot(root), copy);
    fs.rmSync(path.join(root, draftPathOf(designFile("own"))));
    assert.equal(migrate(root, "src/own").ok, true);
    editFile(root, designFile("own"), text => text + "\nChanged active prose.\n");
    const changed = snapshot(root);
    assert.equal(migrate(root, "src/own").ok, false);
    assert.deepEqual(snapshot(root), changed);
    fs.rmSync(path.join(root, draftPathOf(designFile("own"))));
    writeFile(root, designFile("own"), mdx(contract("Worker")));
    const noRules = snapshot(root);
    assert.equal(migrate(root, "src/own").files[0].status, "unchanged");
    assert.deepEqual(snapshot(root), noRules);
  });

  /** @covers migrate-preserves migrate-mixed */
  test("family invariants and localized or unclosed Gherkin blocks migrate without inventing Examples", t => {
    const family = contract("Work", "run(): void;", "@invariant once Runs once.").replace("@contract", "@family");
    for (const block of ['```gherkin design\n@Work\n# language: uk\nФункціонал: Робота\n  Rule: existing — Робота завершується.\n```\n', '```gherkin design\n@Work\nFeature: Work\n  Rule: existing — Existing work finishes.']) {
      // Language headers precede tags in a valid Gherkin document.
      const localized = block.replace('@Work\n# language: uk', '# language: uk\n@Work');
      const root = designProject(t, { own: mdx(family) + localized });
      const report = migrate(root, "src/own");
      assert.equal(report.ok, true, JSON.stringify(report));
      const after = candidate(root, designFile("own")).content;
      assert.equal(ruleSet(after, designFile("own")).length, 2);
      assert.equal(parseDesignMdx(after, designFile("own")).gherkin!.rules[1].examples.length, 0);
      if (localized.includes("language: uk")) assert.match(after, /Rule: once — Runs once\./);
    }
  });

  /** @covers migrate-preserves migrate-conflict */
  test("unsafe ids, carriers, duplicates and unbound invariants are refused without losing text", t => {
    const bad = [
      mdx(contract("Worker", "run(): void;", "@invariant bad--id Runs once.")),
      mdx(contract("worker", "run(): void;", "@invariant once Runs once.")),
      mdx(contract("Worker", "run(): void;", "@invariant once Runs once.", "@invariant once Runs twice.")),
      mdx('/** @invariant once Runs once. */\nexport interface Worker { run(): void; }'),
      mdx(contract("Worker", "run(): void;", "@invariant once Runs once.")) + '```gherkin design\n@Worker\nFeature: Work\n  Rule: once — Runs once.\n```\n',
    ];
    for (const source of bad) {
      const root = designProject(t, { own: source }), before = snapshot(root);
      const report = migrate(root, "src/own");
      assert.equal(report.ok, false, source);
      assert.ok(report.diagnostics.some(item => item.code === "E_MIGRATE"));
      assert.deepEqual(snapshot(root), before);
    }
  });

  /** @covers migrate-drafts migrate-preserves migrate-repeat */
  test("ordinary activation preserves locks and test links and stales reviews without rewriting their records", t => {
    const root = copyFixture(t, "vertical");
    editFile(root, QUOTA, text => text.replace(" * @contract", " * @contract\n * @final"));
    assert.equal(cli(root, "lock").code, 0);
    const packet = JSON.parse(cli(root, "review", "Quota", "--format", "json").stdout).contracts[0];
    writeFile(root, "verdict.json", JSON.stringify({ version: 1, verdicts: [{ contract: "Quota", fingerprint: packet.fingerprint, findings: packet.invariants.map((rule: { id: string }) => ({ invariant: rule.id, assessment: "adequate", reason: "Synthetic fixture review.", evidence: "fixture tests", suggestedChange: null })) }] }));
    assert.equal(cli(root, "review", "--record", "verdict.json").code, 0);
    const before = JSON.parse(cli(root, "check", "--format", "json").stdout);
    const records = readFile(root, ".cage/review.json"), locks = readFile(root, ".cage/lock.json");
    assert.equal(migrate(root, "src/modules/quota").ok, true);
    assert.equal(cli(root, "check", "--format", "json").stdout, JSON.stringify(before, null, 2) + "\n");
    assert.equal(cli(root, "draft", "check", draftPathOf(QUOTA)).code, 0);
    const activated = cli(root, "draft", "activate", draftPathOf(QUOTA));
    assert.equal(activated.code, 0, activated.stdout + activated.stderr);
    const after = JSON.parse(cli(root, "check", "--format", "json").stdout);
    assert.equal(after.counts.invariants, before.counts.invariants);
    assert.equal(after.counts.linkedInvariants, before.counts.linkedInvariants);
    assert.ok(after.diagnostics.some((item: { code: string; contract?: string }) => item.code === "W_REVIEW_STALE" && item.contract === "Quota"));
    assert.ok(!after.diagnostics.some((item: { severity: string }) => item.severity === "error"));
    assert.equal(readFile(root, ".cage/review.json"), records);
    assert.equal(readFile(root, ".cage/lock.json"), locks);
    const active = snapshot(root);
    assert.equal(migrate(root, "src/modules/quota").files[0].status, "unchanged");
    assert.deepEqual(snapshot(root), active);
  });

  /** @covers migrate-preserves migrate-drafts */
  test("Cage's own multi-contract spec keeps every id and logical sentence in a scratch migration", t => {
    const source = fs.readFileSync(path.resolve("src/cage.cage.mdx"), "utf8");
    const root = designProject(t, { own: source });
    const before = checkDesigns(root).index.invariants.map(rule => ({ carrier: rule.contract + (rule.member ? "." + rule.member : ""), id: rule.id, text: rule.text }));
    assert.ok(before.length > 50);
    const report = migrate(root, "src/own");
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(ruleSet(candidate(root, designFile("own")).content, designFile("own")), before);
    assert.equal(cli(root, "draft", "check", draftPathOf(designFile("own"))).code, 0);
    assert.equal(readFile(root, designFile("own")), source);
  });

  /** @covers migrate-conflict migrate-drafts */
  test("draft creation rechecks the prepared source and refuses destination links", t => {
    const root = designProject(t, { own: mdx(contract("Worker", "run(): void;", "@invariant once Runs once.")) });
    const target = designFile("own"), before = snapshot(root);
    const report = createDraft({ root, config: defaultConfig, problems: [] }, target, { source: "an older snapshot", content: "proposed" });
    assert.ok(report.diagnostics.some(item => item.code === "E_DRAFT_CONFLICT"));
    assert.deepEqual(snapshot(root), before);
    fs.symlinkSync(path.join(root, target), path.join(root, draftPathOf(target)));
    assert.equal(migrate(root, "src/own").ok, false);
    assert.equal(readFile(root, target), before[target]);
  });

  /** @covers migrate-preview migrate-drafts */
  test("migration validates its arguments and reports missing modules without writing", t => {
    const root = designProject(t, { own: mdx(contract("Worker")) });
    const before = snapshot(root);
    for (const args of [["migrate"], ["migrate", "other", "src/own"], ["migrate", "gherkin"], ["migrate", "gherkin", "../escape"], ["migrate", "gherkin", "/tmp"], ["migrate", "gherkin", "src/own", "--force"], ["migrate", "gherkin", "src/own", "--carry-reviews"], ["check", "--dry-run"]]) assert.equal(cli(root, ...args).code, 2, args.join(" "));
    assert.equal(migrate(root, "src/missing").ok, false);
    assert.deepEqual(snapshot(root), before);
  });
});
