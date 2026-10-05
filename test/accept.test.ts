import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { CheckReport } from "../src/check.ts";
import { REVIEW_FILE, type AcceptReport, type Finding, type ReviewEntry } from "../src/review-record.ts";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { cli, cliWithStdin, copyFixture, editFile, readFile, snapshot, writeFile } from "./helpers.ts";

const SEND_TEST = "src/modules/campaigns/send.test.ts";

function accept(root: string, ...args: string[]): { code: number; report: AcceptReport } {
  const { code, stdout, stderr } = cli(root, "review", "--accept", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

function check(root: string): { code: number; report: CheckReport } {
  const { code, stdout, stderr } = cli(root, "check", "--format", "json");
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

const packet = (root: string, ...args: string[]) => JSON.parse(cli(root, "review", "--format", "json", ...args).stdout) as ReviewReport;
const index = (root: string, ...args: string[]) => JSON.parse(cli(root, "review", "--format", "json", ...args).stdout) as ReviewIndex;
const entries = (root: string) => (JSON.parse(readFile(root, REVIEW_FILE)) as { reviews: ReviewEntry[] }).reviews;
const reviewCodes = (root: string) => check(root).report.diagnostics.filter(({ code }) => code.includes("REVIEW_")).map(({ code, contract }) => `${code} ${contract}`);

/** A complete verdict for a contract, from its packet: every invariant adequate. */
function verdictFor(root: string, name: string) {
  const [contract] = packet(root, name).contracts;
  const findings: Finding[] = (contract.invariants.length === 0 ? [null] : contract.invariants.map(({ id }) => id)).map((invariant) => ({ invariant, assessment: "adequate", reason: "judged.", evidence: `${SEND_TEST}:1`, suggestedChange: null }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts: [{ contract: name, fingerprint: contract.fingerprint, findings }] }));
  return cli(root, "review", "--record", path.join(root, "verdicts.json"));
}

test("review --accept records every contract in need of a review as accepted without a verdict, and check asks for none", (t) => {
  const root = copyFixture(t, "vertical");
  assert.deepEqual(reviewCodes(root), ["W_REVIEW_MISSING Send", "W_REVIEW_MISSING Sender", "W_REVIEW_MISSING Quota"]);
  const fingerprints = Object.fromEntries(index(root, "--all").contracts.map(({ contract, fingerprint }) => [contract, fingerprint]));

  const before = snapshot(root);
  const text = cli(root, "review", "--accept");
  assert.equal(text.code, 0);
  assert.equal(
    text.stdout,
    [
      "○ accepted  Send (4 invariants, no record before)",
      "○ accepted  Sender (0 invariants, no record before)",
      "○ accepted  Quota (4 invariants, no record before)",
      `review --accept: 3 accepted without a review in ${REVIEW_FILE}; check asks for no review of their material as it is now, and nothing attests that their tests check the invariants.`,
      "",
    ].join("\n"),
  );
  // Only the review file was written.
  assert.deepEqual(Object.keys(snapshot(root)).filter((file) => !(file in before)), [REVIEW_FILE]);

  // An acceptance is a record of the material, with no finding: nobody judged anything.
  const recorded = entries(root);
  assert.deepEqual(recorded.map(({ contract }) => contract), ["Send", "Sender", "Quota"]);
  for (const entry of recorded) {
    assert.deepEqual(Object.keys(entry), ["module", "contract", "fingerprint", "material", "findings", "accepted"]);
    assert.equal(entry.fingerprint, fingerprints[entry.contract]);
    assert.deepEqual(entry.findings, []);
    assert.equal(entry.accepted, true);
    assert.ok(Object.keys(entry.material).includes("contract"));
  }

  // check: no review is asked for, and the acceptances are counted apart from anything attested.
  const { code, report } = check(root);
  assert.equal(code, 0);
  assert.deepEqual(reviewCodes(root), []);
  assert.equal(report.counts.reviewedInvariants, 0);
  assert.equal(report.counts.acceptedInvariants, 8);
  assert.equal(report.counts.acceptedContracts, 3);
  assert.ok(report.invariants?.every(({ review }) => review === "accepted"));
  assert.match(cli(root, "check").stdout, /reviews: 0 attested adequate, 0 found weak, 0 unreviewed, 3 contracts accepted without review \(8 invariants\); 0 errors, 1 warning\./);
  // The gate lets the agent stop: nothing is missing or stale.
  assert.equal(cliWithStdin(root, JSON.stringify({ session_id: "accept-test" }), "gate").code, 0);

  // The packet says that the material was accepted, not reviewed; without names nothing is exported.
  const [send] = packet(root, "Send").contracts;
  assert.deepEqual(send.recordedReview, { status: "accepted", assessments: null, contractAssessments: null });
  assert.deepEqual(send.priorNotes, []);
  assert.ok(cli(root, "review", "Send").stdout.includes("- ○ Recorded review: none — this material was accepted without a review (`cage review --accept`); adequacy is not attested; record a verdict with `cage review --record`"));
  assert.deepEqual(index(root).contracts, []);

  // Running it again changes nothing: every contract has a record of its material as it is now.
  const again = cli(root, "review", "--accept");
  assert.equal(again.code, 0);
  assert.equal(again.stdout, ["= kept      Send (an acceptance for this material)", "= kept      Sender (an acceptance for this material)", "= kept      Quota (an acceptance for this material)", "review --accept: nothing to accept, 3 kept: every contract has a record of its material as it is now.", ""].join("\n"));
  assert.equal(readFile(root, REVIEW_FILE), snapshot(root)[REVIEW_FILE]);
});

test("a change makes an acceptance outdated like a review; --accept without names renews only those, and keeps a verdict", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(accept(root).code, 0);
  editFile(root, SEND_TEST, (s) => s.replace('it("не передає повідомлення без квоти"', 'it("не передає повідомлення без квоти (edited)"'));
  const stale = check(root).report.diagnostics.filter(({ code }) => code === "W_REVIEW_STALE");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].contract, "Send");
  assert.match(stale[0].message, /^The acceptance of contract "Send" \(recorded without a review\) is for other material; since then:\n- test "не передає повідомлення без квоти \(edited\)" \(src\/modules\/campaigns\/send\.test\.ts\) is new\n- test "не передає повідомлення без квоти" \(src\/modules\/campaigns\/send\.test\.ts\) is gone\nReview it\.$/);
  assert.deepEqual(index(root).contracts.map(({ contract, status }) => `${contract} ${status}`), ["Send outdated"]);
  // The gate blocks on an outdated acceptance as on an outdated review.
  assert.equal(cliWithStdin(root, JSON.stringify({ session_id: "accept-stale" }), "gate").code, 2);

  // A real verdict for Quota replaces its acceptance.
  assert.equal(verdictFor(root, "Quota").code, 0);
  assert.equal(entries(root).find(({ contract }) => contract === "Quota")?.accepted, undefined);
  // Send's acceptance is outdated: its invariants are unreviewed; Sender's acceptance stands, with no invariant to count.
  assert.match(cli(root, "check").stdout, /reviews: 4 attested adequate, 0 found weak, 4 unreviewed, 1 contract accepted without review \(0 invariants\)/);

  // Without names: the outdated acceptance is renewed, the verdict and the fresh acceptance are kept.
  const renewed = accept(root);
  assert.equal(renewed.code, 0);
  assert.equal(renewed.report.selection, "needed");
  assert.deepEqual(renewed.report.accepted.map(({ contract, invariants, replaced }) => ({ contract, invariants, replaced })), [{ contract: "Send", invariants: 4, replaced: { kind: "acceptance", current: false } }]);
  assert.deepEqual(renewed.report.kept, [
    { module: "src/modules/mail", contract: "Sender", record: "acceptance" },
    { module: "src/modules/quota", contract: "Quota", record: "verdict" },
  ]);
  assert.deepEqual(reviewCodes(root), []);
  assert.equal(
    cli(root, "review", "--accept").stdout,
    ["= kept      Send (an acceptance for this material)", "= kept      Sender (an acceptance for this material)", "= kept      Quota (a recorded verdict for this material)", "review --accept: nothing to accept, 3 kept: every contract has a record of its material as it is now.", ""].join("\n"),
  );

  // A named contract, and --all, replace a verdict too; the report says so.
  const named = cli(root, "review", "--accept", "Quota");
  assert.equal(named.code, 0);
  assert.equal(named.stdout, ["○ accepted  Quota (4 invariants, replaces the verdict for this material)", `review --accept: 1 accepted without a review in ${REVIEW_FILE}; check asks for no review of their material as it is now, and nothing attests that their tests check the invariants.`, ""].join("\n"));
  assert.equal(entries(root).find(({ contract }) => contract === "Quota")?.accepted, true);
  assert.equal(verdictFor(root, "Send").code, 0);
  const all = accept(root, "--all");
  assert.equal(all.report.selection, "all");
  assert.deepEqual(all.report.accepted.map(({ contract, replaced }) => ({ contract, replaced })), [{ contract: "Send", replaced: { kind: "verdict", current: true } }]);
  assert.deepEqual(all.report.kept.map(({ contract }) => contract), ["Sender", "Quota"]);
  assert.ok(entries(root).every(({ accepted }) => accepted === true));
});

test("--accept refuses an unknown contract and records nothing; the flags exclude one another; a tampered acceptance is unusable", (t) => {
  const root = copyFixture(t, "vertical");
  const unknown = accept(root, "Send", "Nobody");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.report.ok, false);
  assert.deepEqual(unknown.report.accepted, []);
  assert.deepEqual(unknown.report.diagnostics.map(({ code, message }) => ({ code, message })), [{ code: "E_REFERENCE_UNKNOWN", message: 'There is no contract "Nobody" in the designs.' }]);
  assert.ok(!fs.existsSync(path.join(root, REVIEW_FILE)));
  assert.match(cli(root, "review", "--accept", "Nobody").stdout, /review --accept: 1 error, nothing recorded\.$/m);

  assert.match(cli(root, "review", "--accept", "--record", "verdicts.json").stderr, /--accept records acceptances, --record a reviewer's verdicts; pass one of them\./);
  assert.match(cli(root, "check", "--accept").stderr, /--accept is an option of the review command\./);
  assert.match(cli(root, "review", "--accept", "--all", "Send").stderr, /--all reviews every contract/);
  assert.match(cli(root, "review", "--accept", "--format", "markdown").stderr, /Unknown format "markdown" for review --accept; expected text or json\./);

  // An acceptance carries no finding; a file that says otherwise was not written by cage.
  assert.equal(accept(root, "Send").code, 0);
  const file = JSON.parse(readFile(root, REVIEW_FILE)) as { reviews: ReviewEntry[] };
  file.reviews[0].findings = [{ invariant: "quota", assessment: "adequate", reason: "r", evidence: "e", suggestedChange: null }];
  writeFile(root, REVIEW_FILE, JSON.stringify(file));
  const broken = check(root);
  assert.equal(broken.code, 2);
  assert.match(broken.report.diagnostics[0].message, /^The review file is not usable: /);
});
