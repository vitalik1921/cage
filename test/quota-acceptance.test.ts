import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";
import { cli, copyFixture, readFile, writeFile } from "./helpers.ts";

/** @tests Cli
 * @covers example-links gherkin-review-packet record-refuses */
test("the README's Gherkin Quota runs and passes with required examples and an adequate recorded review", t => {
  const root = copyFixture(t, "quota-gherkin");
  const readme = fs.readFileSync(path.join(import.meta.dirname, "..", "README.md"), "utf8");
  const example = /````mdx\n(# Quota\n[\s\S]*?)````/.exec(readme)?.[1];
  assert.equal(example, readFile(root, "src/quota.cage.mdx"));
  const execution = spawnSync(process.execPath, ["--test", "src/quota.test.ts"], { cwd: root, encoding: "utf8" });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);

  const initial = JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
  assert.deepEqual(initial.diagnostics.map(item => item.code), ["E_REVIEW_MISSING"]);
  const packet = JSON.parse(cli(root, "review", "Quota", "--format", "json").stdout) as ReviewReport;
  assert.equal(packet.complete, true);
  assert.equal(packet.gherkin?.length, 1);
  assert.ok(packet.contracts[0].invariants.every(rule => rule.gherkin?.examples.length === 1 && rule.gherkin.examples[0].tests.length === 1));
  // These findings are an authored reading of the runnable fixture, not a title-link assessment.
  const verdict = { version: 1, verdicts: [{ contract: "Quota", fingerprint: packet.contracts[0].fingerprint, findings: JSON.parse(readFile(root, "review-findings.json")) }] };
  writeFile(root, "verdict.json", JSON.stringify({ ...verdict, verdicts: [{ ...verdict.verdicts[0], findings: verdict.verdicts[0].findings.slice(0, 1) }] }));
  assert.equal(cli(root, "review", "--record", "verdict.json").code, 1, "every rule needs a finding");
  writeFile(root, "verdict.json", JSON.stringify(verdict));
  const recorded = cli(root, "review", "--record", "verdict.json");
  assert.equal(recorded.code, 0, recorded.stdout + recorded.stderr);
  const checked = cli(root, "check", "--format", "json");
  assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  const report = JSON.parse(checked.stdout) as CheckReport;
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.counts.invariants, 2);
  assert.equal(report.counts.linkedInvariants, 2);
  assert.ok(report.invariants?.every(rule => rule.review === "adequate"));
});
