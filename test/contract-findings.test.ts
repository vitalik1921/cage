import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { CheckReport } from "../src/check.ts";
import type { ReviewReport } from "../src/review.ts";
import { REVIEW_FILE, type Finding, type RecordReport } from "../src/review-record.ts";
import { cli, copyFixture, readFile, writeFile } from "./helpers.ts";

const QUOTA_INVARIANTS = ["accounts", "empty", "consume", "race"];
const NONE = { adequate: 0, weak: 0, unrelated: 0, "insufficient-context": 0 };
const finding = (invariant: string | null, assessment: Finding["assessment"] = "adequate", reason = "read the test"): Finding => ({
  invariant,
  assessment,
  reason,
  evidence: assessment === "insufficient-context" ? null : "src/modules/quota/quota.test.ts:9",
  suggestedChange: null,
});
const packet = (root: string, name: string) => (JSON.parse(cli(root, "review", name, "--format", "json").stdout) as ReviewReport).contracts[0];
/** The packet's line about the recorded review. */
const statusOf = (root: string, name: string) => /^review: .*$/m.exec(cli(root, "review", name).stdout)?.[0] ?? "";
const checkJson = (root: string) => JSON.parse(cli(root, "check", "--format", "json").stdout) as CheckReport;
function record(root: string, verdicts: unknown, file = "verdicts.json") {
  writeFile(root, file, JSON.stringify(verdicts));
  const json = cli(root, "review", "--record", file, "--format", "json");
  return { code: json.code, report: JSON.parse(json.stdout) as RecordReport };
}
const quotaVerdict = (root: string, ...extra: Finding[]) => ({ contract: "Quota", fingerprint: packet(root, "Quota").fingerprint, findings: [...QUOTA_INVARIANTS.map((id) => finding(id)), ...extra] });

for (const assessment of ["weak", "unrelated", "insufficient-context"] as const) {
  test(`a contract-level finding assessed ${assessment} is recorded as one, and --record, the packet and check all say so`, (t) => {
    const root = copyFixture(t, "vertical");
    const { code, report } = record(root, { version: 1, verdicts: [quotaVerdict(root, finding(null, assessment, "Contract-level concern. More detail."))] });
    assert.equal(code, 0);
    assert.deepEqual(report.recorded.map(({ assessments, contractAssessments, notes }) => ({ assessments, contractAssessments, notes })), [
      { assessments: { ...NONE, adequate: 4 }, contractAssessments: { ...NONE, [assessment]: 1 }, notes: [`${assessment}: Contract-level concern.`] },
    ]);
    // The text is recorded again from the same file: what a person sees.
    const text = cli(root, "review", "--record", "verdicts.json").stdout;
    assert.ok(text.startsWith(`! recorded  Quota (4 adequate; the contract as a whole: 1 ${assessment}; 1 note)\n            note: ${assessment}: Contract-level concern.\n`), text);
    assert.doesNotMatch(text, /✓/);

    assert.deepEqual(packet(root, "Quota").recordedReview, { status: "current", assessments: { ...NONE, adequate: 4 }, contractAssessments: { ...NONE, [assessment]: 1 } });
    assert.deepEqual(packet(root, "Quota").priorNotes, [`${assessment}: Contract-level concern.`]);
    const status = statusOf(root, "Quota");
    assert.equal(status, `review: current: 4 adequate; the contract as a whole: 1 ${assessment}`);

    const check = checkJson(root);
    const weak = check.diagnostics.filter(({ code, contract }) => code === "W_REVIEW_WEAK" && contract === "Quota");
    assert.deepEqual(weak.map(({ message, invariant }) => ({ message, invariant })), [{ message: `Quota (the contract as a whole) ${assessment}\nContract-level concern. More detail.`, invariant: undefined }]);
    assert.equal(check.counts.weakContracts, 1);
    assert.equal(check.counts.reviewedInvariants, 4);
    assert.match(cli(root, "check").stdout, /reviews: 4 attested adequate, 0 found weak, 4 unreviewed, 1 contract found weak as a whole;/);
    // Required reviews make it an error: the gate and every surface agree that this review found fault.
    writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "require" }));
    const required = cli(root, "check");
    assert.equal(required.code, 1);
    assert.match(required.stdout, /E_REVIEW_WEAK: Quota \(the contract as a whole\) (weak|unrelated|insufficient-context) \(/);
  });
}

test("an adequate contract-level note is an observation: ✓ everywhere, nothing for check to report", (t) => {
  const root = copyFixture(t, "vertical");
  const { code, report } = record(root, { version: 1, verdicts: [quotaVerdict(root, finding(null, "adequate", "A constraint no rule mentions. Detail."))] });
  assert.equal(code, 0);
  assert.deepEqual(report.recorded[0].contractAssessments, { ...NONE, adequate: 1 });
  assert.deepEqual(report.recorded[0].notes, ["A constraint no rule mentions."]);
  assert.match(cli(root, "review", "--record", "verdicts.json").stdout, /^✓ recorded {2}Quota \(4 adequate; 1 note\)\n {12}note: A constraint no rule mentions\.\n/);
  assert.equal(statusOf(root, "Quota"), "review: current: 4 adequate");
  const check = checkJson(root);
  assert.equal(check.counts.weakContracts, 0);
  assert.deepEqual(check.diagnostics.filter(({ code, contract }) => code.includes("REVIEW") && contract === "Quota"), []);
  assert.doesNotMatch(cli(root, "check").stdout, /found weak as a whole/);

  // A contract without invariants: its one finding is about the contract as a whole, and is what the status names.
  const sender = record(root, { version: 1, verdicts: [{ contract: "Sender", fingerprint: packet(root, "Sender").fingerprint, findings: [finding(null, "weak", "Nothing is promised.")] }] });
  assert.equal(sender.code, 0);
  assert.match(cli(root, "review", "--record", "verdicts.json").stdout, /^! recorded {2}Sender \(no invariants; the contract as a whole: 1 weak; 1 note\)/);
  assert.match(statusOf(root, "Sender"), /^review: current: the contract as a whole: 1 weak$/);
  assert.equal(checkJson(root).counts.weakContracts, 1);
});

test("a review file written before contract-level assessments were counted is read the same way: no surface shows it green", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(record(root, { version: 1, verdicts: [quotaVerdict(root, finding(null, "adequate", "Concern."))] }).code, 0);
  // As cage 0.2.5 accepted and stored it: the same entry, its contract-level finding weak.
  const file = JSON.parse(readFile(root, REVIEW_FILE)) as { reviews: { findings: Finding[] }[] };
  file.reviews[0].findings.find((candidate) => candidate.invariant === null)!.assessment = "weak";
  writeFile(root, REVIEW_FILE, JSON.stringify(file, null, 2));

  assert.equal(packet(root, "Quota").recordedReview.status, "current");
  assert.deepEqual(packet(root, "Quota").recordedReview.contractAssessments, { ...NONE, weak: 1 });
  assert.match(statusOf(root, "Quota"), /^review: current: .*the contract as a whole: 1 weak$/);
  assert.equal(checkJson(root).counts.weakContracts, 1);
  assert.ok(checkJson(root).diagnostics.some(({ code, contract }) => code === "W_REVIEW_WEAK" && contract === "Quota"));
});

test("one bad verdict refuses the whole batch: the review file is not written, not even for the good verdicts", (t) => {
  const root = copyFixture(t, "vertical");
  const reviewFile = path.join(root, REVIEW_FILE);
  const send = (JSON.parse(cli(root, "review", "Send", "--format", "json").stdout) as ReviewReport).contracts[0];
  const good = quotaVerdict(root, finding(null, "weak", "Contract-level concern."));
  const bad = { contract: "Send", fingerprint: send.fingerprint, findings: [...send.invariants.map(({ id }) => finding(id)), finding("no-such-invariant")] };

  const first = record(root, { version: 1, verdicts: [good, bad] });
  assert.equal(first.code, 1);
  assert.deepEqual(first.report.recorded, []);
  assert.deepEqual(first.report.diagnostics.map(({ code }) => code), ["E_REVIEW_VERDICT"]);
  assert.equal(fs.existsSync(reviewFile), false);
  assert.match(cli(root, "review", "--record", "verdicts.json").stdout, /review --record: 1 error, nothing recorded\.\n$/);

  // With a review file already there, it stays byte for byte what it was.
  assert.equal(record(root, { version: 1, verdicts: [quotaVerdict(root)] }).code, 0);
  const before = fs.readFileSync(reviewFile);
  assert.equal(record(root, { version: 1, verdicts: [good, bad] }).code, 1);
  // An assessment outside the four is a verdict of another shape: refused before anything is compared.
  const odd = record(root, { version: 1, verdicts: [{ ...good, findings: [...good.findings.slice(0, 4), { ...finding(null), assessment: "fine" }] }] });
  assert.equal(odd.code, 2);
  assert.deepEqual(odd.report.diagnostics.map(({ code }) => code), ["E_CONFIG"]);
  assert.deepEqual(fs.readFileSync(reviewFile), before);
  assert.deepEqual(packet(root, "Quota").recordedReview.contractAssessments, NONE);
});
