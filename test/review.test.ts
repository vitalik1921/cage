import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { ReviewReport } from "../src/review.ts";
import type { CheckReport } from "../src/check.ts";
import { REVIEW_FILE, type Finding, type RecordReport } from "../src/review-record.ts";
import { CAMPAIGNS, cli, copyFixture, editFile, inFixture, isError, MAIL, QUOTA, readFile, snapshot, writeFile } from "./helpers.ts";

const SEND_SERVICE = "src/modules/campaigns/send-service.ts";
const SEND_TEST = "src/modules/campaigns/send.test.ts";
const CALLBACK_SENDER = "src/modules/mail/callback-sender.ts";

function review(root: string, ...args: string[]): { code: number; report: ReviewReport } {
  const { code, stdout, stderr } = cli(root, "review", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}

/** The plan fixture with its generated files written, so that the check behind the review is clean. */
function extracted(t: TestContext): string {
  const root = copyFixture(t, "vertical");
  assert.equal(cli(root, "extract").code, 0);
  return root;
}

test("a packet holds the contract, its design, the designs it depends on, its implementations and its tests, each file once", (t) => {
  const root = extracted(t);
  const before = snapshot(root);
  const { code, report } = review(root, "Send");
  assert.equal(code, 0);
  assert.deepEqual(snapshot(root), before);
  assert.equal(report.ok, true);
  assert.equal(report.complete, true);
  assert.equal(report.selection, "named");
  assert.deepEqual(
    report.files.map(({ path, role }) => ({ path, role })),
    [
      { path: CAMPAIGNS, role: "design" },
      { path: SEND_SERVICE, role: "implementation" },
      { path: SEND_TEST, role: "test" },
      { path: MAIL, role: "design" },
      { path: QUOTA, role: "design" },
    ],
  );
  assert.equal(report.files.find((file) => file.path === SEND_TEST)?.text, readFile(root, SEND_TEST));

  const [packet] = report.contracts;
  assert.equal(report.contracts.length, 1);
  assert.equal(packet.contract, "Send");
  assert.equal(packet.module, "src/modules/campaigns");
  assert.equal(packet.design, CAMPAIGNS);
  assert.match(packet.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(packet.dependencies, {
    uses: [
      { contract: "Quota", module: "src/modules/quota" },
      { contract: "Sender", module: "src/modules/mail" },
    ],
    usedBy: [],
    // Quota comes both from `@uses` and from the type import of AccountId; it is listed once.
    designs: [MAIL, QUOTA],
  });
  assert.deepEqual(packet.members.map(({ name, location }) => ({ name, ...location })), [{ name: "run", ...inFixture(CAMPAIGNS, "run(") }]);
  assert.deepEqual(
    packet.invariants.map(({ id, member, tests }) => ({ id, member, tests: tests.map((declaration) => `${declaration.file}:${declaration.line}`) })),
    ["quota", "limit", "quota-error", "sender-error"].map((id, order) => ({
      id,
      member: "run",
      tests: [`${SEND_TEST}:${inFixture(SEND_TEST, ["чекає на підтвердження", "не передає повідомлення", "передає помилку квоти", "передає помилку транспорту"][order]).line}`],
    })),
  );
  assert.deepEqual(packet.implementations, [{ name: "SendService", kind: "class", compatible: true, location: inFixture(SEND_SERVICE, "SendService") }]);
  assert.deepEqual(packet.tests.map((file) => ({ file, count: file.declarations.length })).map(({ file, count }) => ({ file: file.file, count })), [{ file: SEND_TEST, count: 4 }]);
  assert.deepEqual(packet.tests[0].declarations[0].suitePath, ["SendService"]);
  // The test file imports the Sender implementation, which is not material of Send: the reviewer is told.
  assert.deepEqual(packet.unloaded, [CALLBACK_SENDER]);
  // The Sender warning is about a file of the packet.
  assert.deepEqual(packet.diagnostics.map(({ code }) => code), ["W_NO_INVARIANTS"]);
});

test("the fingerprint changes with any file of the packet and with nothing else", (t) => {
  const root = extracted(t);
  const fingerprint = () => review(root, "Send").report.contracts[0].fingerprint;
  const first = fingerprint();
  assert.equal(fingerprint(), first);

  editFile(root, "src/modules/quota/quota.test.ts", (s) => `${s}// a change to a test of another contract\n`);
  assert.equal(fingerprint(), first);
  editFile(root, SEND_TEST, (s) => `${s}// a change to a test of Send\n`);
  const afterTest = fingerprint();
  assert.notEqual(afterTest, first);
  // Prose of a dependency's design is material too.
  editFile(root, QUOTA, (s) => s.replace("# ", "# Модуль: "));
  assert.notEqual(fingerprint(), afterTest);
  assert.equal(review(root, "Sender").report.contracts[0].fingerprint, review(root, "Sender").report.contracts[0].fingerprint);
});

test("the markdown document lists the contracts and every file once, in fences longer than any run of backticks inside", (t) => {
  const root = extracted(t);
  editFile(root, SEND_TEST, (s) => `${s}// a comment with \`\`\`\` four backticks\n`);
  const { code, stdout } = cli(root, "review", "Send", "Quota");
  assert.equal(code, 0);
  assert.ok(stdout.startsWith("# Design review\n"));
  assert.equal(stdout.match(/^## Contract /gm)?.length, 2);
  assert.deepEqual(
    stdout.match(/^### src\/.*$/gm),
    [`### ${CAMPAIGNS} (design)`, `### ${SEND_SERVICE} (implementation)`, `### ${SEND_TEST} (test)`, `### ${MAIL} (design)`, `### ${QUOTA} (design)`, "### src/modules/quota/memory-quota.ts (implementation)", "### src/modules/quota/quota.test.ts (test)"],
  );
  assert.ok(stdout.includes("\n`````ts\n"), "fences are five backticks");
  assert.ok(!stdout.includes("\n````ts\n"));
  assert.ok(stdout.includes("- uses: Quota (src/modules/quota), Sender (src/modules/mail)"));
  assert.ok(stdout.includes("## Result format"));
  assert.ok(stdout.includes(`- ${CALLBACK_SENDER}`), "the file that is not loaded is listed");
});

test("without names the contracts in need of a review are exported, which is all of them at first; an unknown name is an error", (t) => {
  const root = extracted(t);
  const needed = review(root);
  assert.equal(needed.code, 0);
  assert.equal(needed.report.selection, "needed");
  assert.deepEqual(needed.report.contracts.map(({ contract, module }) => `${module} ${contract}`), ["src/modules/campaigns Send", "src/modules/mail Sender", "src/modules/quota Quota"]);
  const all = review(root, "--all");
  assert.equal(all.report.selection, "all");
  assert.deepEqual(all.report.contracts.length, 3);

  const unknown = review(root, "Send", "Nobody");
  assert.equal(unknown.code, 1);
  assert.equal(unknown.report.ok, false);
  assert.deepEqual(unknown.report.contracts.map(({ contract }) => contract), ["Send"]);
  assert.deepEqual(
    unknown.report.diagnostics.filter(({ code }) => code === "E_REFERENCE_UNKNOWN").map(({ message }) => message),
    ['There is no contract "Nobody" in the designs.'],
  );

  const both = cli(root, "review", "--all", "Send");
  assert.equal(both.code, 2);
  assert.match(both.stderr, /--all reviews every contract/);
  assert.match(cli(root, "review", "--format", "text").stderr, /expected markdown or json/);
  assert.match(cli(root, "check", "--all").stderr, /--all is an option of the review command/);
});

test("structural errors do not stop the export: the packet carries them and complete is false", (t) => {
  const root = extracted(t);
  editFile(root, SEND_TEST, (s) => s.replace("/** @covers sender-error */", "/** no cover */"));
  const { code, report } = review(root, "Send");
  assert.equal(code, 0);
  assert.equal(report.ok, true);
  assert.equal(report.complete, false);
  const [packet] = report.contracts;
  assert.deepEqual(packet.invariants.find((invariant) => invariant.id === "sender-error")?.tests, []);
  assert.deepEqual(packet.diagnostics.filter(({ severity }) => severity === "error").map(({ code, contract }) => ({ code, contract })), [{ code: "E_TEST_MISSING", contract: "Send" }]);

  // A type error in a design is such an error too: the designs are indexed, the packet is made.
  editFile(root, QUOTA, (s) => s.replace("take(accountId: AccountId)", "take(accountId: AccountIdd)"));
  const typed = review(root, "Send");
  assert.equal(typed.code, 0);
  assert.equal(typed.report.contracts.length, 1);
  assert.ok(typed.report.diagnostics.some(({ code }) => code === "E_TYPESCRIPT"));

  // With a design that cannot be read there is nothing to export.
  editFile(root, QUOTA, (s) => s.replace("export interface Quota {", "export interface {"));
  const broken = review(root, "Send");
  assert.equal(broken.code, 1);
  assert.equal(broken.report.ok, false);
  assert.deepEqual(broken.report.contracts, []);
  assert.deepEqual(broken.report.files, []);
  assert.ok(broken.report.diagnostics.some(({ code }) => code === "E_TYPESCRIPT"));

  writeFile(root, ".design/config.json", "{ nope");
  assert.equal(cli(root, "review").code, 2);
});

const VERDICTS = "verdicts.json";

function check(root: string, ...args: string[]): { code: number; report: CheckReport } {
  const { code, stdout, stderr } = cli(root, "check", "--format", "json", ...args);
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}
const reviewDiagnostics = (root: string, ...args: string[]) =>
  check(root, ...args).report.diagnostics.filter(({ code }) => code.includes("REVIEW")).map(({ code, message, contract, invariant, file, line, column }) => ({ code, message, contract, invariant, file, line, column }));

function record(root: string, verdicts: unknown): { code: number; report: RecordReport } {
  writeFile(root, VERDICTS, JSON.stringify(verdicts));
  const { code, stdout, stderr } = cli(root, "review", "--record", VERDICTS, "--format", "json");
  assert.equal(stderr, "");
  return { code, report: JSON.parse(stdout) };
}
const finding = (invariant: string | null, assessment: Finding["assessment"] = "adequate", extra: Partial<Finding> = {}): Finding => ({
  invariant,
  assessment,
  reason: `${invariant ?? "the contract"} looked ${assessment}`,
  evidence: null,
  suggestedChange: null,
  ...extra,
});
const SEND_INVARIANTS = ["quota", "limit", "quota-error", "sender-error"];
const fingerprintOf = (root: string, name: string) => review(root, name).report.contracts[0].fingerprint;

test("a recorded verdict makes check content with the contract, and the review file says what was reviewed", (t) => {
  const root = extracted(t);
  // Until something is recorded, every contract is reported; by default as a warning.
  const before = check(root);
  assert.equal(before.code, 0);
  assert.deepEqual(
    reviewDiagnostics(root).map(({ code, contract }) => ({ code, contract })),
    [{ code: "W_REVIEW_MISSING", contract: "Send" }, { code: "W_REVIEW_MISSING", contract: "Sender" }, { code: "W_REVIEW_MISSING", contract: "Quota" }],
  );
  assert.ok(before.report.diagnostics.find(({ code }) => code === "W_REVIEW_MISSING")?.message.includes("Run `design review Send`"));
  // The design phase does not have the material of a review.
  assert.deepEqual(reviewDiagnostics(root, "--phase", "design"), []);

  const fingerprint = fingerprintOf(root, "Send");
  const recorded = record(root, { version: 1, verdicts: [{ contract: "Send", fingerprint, findings: SEND_INVARIANTS.map((id) => finding(id)) }] });
  assert.equal(recorded.code, 0);
  assert.deepEqual(recorded.report.recorded, [
    { module: "src/modules/campaigns", contract: "Send", fingerprint, assessments: { adequate: 4, weak: 0, unrelated: 0, "insufficient-context": 0 } },
  ]);
  assert.equal(cli(root, "review", "--record", VERDICTS).stdout, `recorded  Send (4 adequate)\nreview --record: 1 recorded in ${REVIEW_FILE}.\n`);

  const file = JSON.parse(readFile(root, REVIEW_FILE));
  assert.deepEqual(Object.keys(file.reviews[0]), ["module", "contract", "fingerprint", "files", "findings"]);
  assert.deepEqual(Object.keys(file.reviews[0].files), [CAMPAIGNS, SEND_SERVICE, SEND_TEST, MAIL, QUOTA]);
  assert.equal(file.reviews[0].fingerprint, fingerprint);

  assert.deepEqual(
    reviewDiagnostics(root).map(({ code, contract }) => ({ code, contract })),
    [{ code: "W_REVIEW_MISSING", contract: "Sender" }, { code: "W_REVIEW_MISSING", contract: "Quota" }],
  );
  // What is fresh is not exported again by default.
  assert.deepEqual(review(root).report.contracts.map(({ contract }) => contract), ["Sender", "Quota"]);

  writeFile(root, ".design/config.json", JSON.stringify({ version: 1, review: "require" }));
  const required = check(root);
  assert.equal(required.code, 1);
  assert.deepEqual(required.report.diagnostics.filter(isError).map(({ code, contract }) => ({ code, contract })), [{ code: "E_REVIEW_MISSING", contract: "Sender" }, { code: "E_REVIEW_MISSING", contract: "Quota" }]);
  writeFile(root, ".design/config.json", JSON.stringify({ version: 1, review: "off" }));
  assert.deepEqual(reviewDiagnostics(root), []);
  writeFile(root, ".design/config.json", JSON.stringify({ version: 1, review: "maybe" }));
  assert.match(check(root).report.diagnostics[0].message, /"review" must be "off", "warn" or "require"/);
});

test("a change to the material makes the review stale, naming the file, and the old verdict cannot be recorded", (t) => {
  const root = extracted(t);
  const fingerprint = fingerprintOf(root, "Send");
  const verdicts = { version: 1, verdicts: [{ contract: "Send", fingerprint, findings: SEND_INVARIANTS.map((id) => finding(id)) }] };
  assert.equal(record(root, verdicts).code, 0);
  const reviewFile = readFile(root, REVIEW_FILE);

  editFile(root, SEND_TEST, (s) => `${s}// the test file changed after the review\n`);
  const contractPosition = inFixture(CAMPAIGNS, "Send {");
  assert.deepEqual(reviewDiagnostics(root).filter(({ contract }) => contract === "Send"), [
    {
      code: "W_REVIEW_STALE",
      message: `The recorded review of contract "Send" is for other material; since then: ${SEND_TEST} changed. Review it again.`,
      contract: "Send",
      invariant: undefined,
      ...contractPosition,
    },
  ]);
  assert.deepEqual(review(root).report.contracts.map(({ contract }) => contract), ["Send", "Sender", "Quota"]);

  const refused = record(root, verdicts);
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.report.recorded, []);
  assert.match(refused.report.diagnostics.find(({ code }) => code === "E_REVIEW_VERDICT")?.message ?? "", /is for fingerprint sha256:[0-9a-f]+, but the material is now sha256:[0-9a-f]+: it changed since the review/);
  assert.equal(readFile(root, REVIEW_FILE), reviewFile);

  // A dependency's design is material too; a file of another contract is not.
  assert.equal(record(root, { ...verdicts, verdicts: [{ ...verdicts.verdicts[0], fingerprint: fingerprintOf(root, "Send") }] }).code, 0);
  editFile(root, QUOTA, (s) => s.replace("# ", "# Модуль: "));
  assert.match(reviewDiagnostics(root).find(({ contract }) => contract === "Send")?.message ?? "", new RegExp(`since then: ${QUOTA} changed`));
  assert.equal(record(root, { ...verdicts, verdicts: [{ ...verdicts.verdicts[0], fingerprint: fingerprintOf(root, "Send") }] }).code, 0);
  editFile(root, "src/modules/quota/quota.test.ts", (s) => `${s}// not material of Send\n`);
  assert.deepEqual(reviewDiagnostics(root).filter(({ contract }) => contract === "Send"), []);
});

test("findings other than adequate are reported where the invariant is, with the reason and the suggestion", (t) => {
  const root = extracted(t);
  const verdicts = {
    version: 1,
    verdicts: [
      {
        contract: "Send",
        fingerprint: fingerprintOf(root, "Send"),
        findings: [
          finding("quota"),
          finding("limit", "weak", { reason: "the test does not call the sender at all", suggestedChange: "assert that sender.send was not called" }),
          finding("quota-error", "unrelated"),
          finding("sender-error", "insufficient-context", { evidence: `${SEND_TEST}:47` }),
          finding(null, "weak", { reason: "no test runs two sends at once" }),
        ],
      },
      // A contract without invariants gets a finding about the contract as a whole.
      { contract: "Sender", fingerprint: fingerprintOf(root, "Sender"), findings: [finding(null)] },
    ],
  };
  const recorded = record(root, verdicts);
  assert.equal(recorded.code, 0);
  assert.deepEqual(recorded.report.recorded.map(({ contract, assessments }) => ({ contract, ...assessments })), [
    { contract: "Send", adequate: 1, weak: 2, unrelated: 1, "insufficient-context": 1 },
    { contract: "Sender", adequate: 1, weak: 0, unrelated: 0, "insufficient-context": 0 },
  ]);
  assert.equal(cli(root, "review", "--record", VERDICTS).stdout.split("\n")[0], "recorded  Send (1 adequate, 2 weak, 1 unrelated, 1 insufficient-context)");

  const at = (needle: string) => inFixture(CAMPAIGNS, needle);
  assert.deepEqual(reviewDiagnostics(root), [
    {
      code: "W_REVIEW_WEAK",
      message: 'The review of contract "Send" found the contract as a whole weak: no test runs two sends at once',
      contract: "Send",
      invariant: undefined,
      ...at("Send {"),
    },
    {
      code: "W_REVIEW_WEAK",
      message: 'The review of contract "Send" found invariant `limit` weak: the test does not call the sender at all Suggested: assert that sender.send was not called',
      contract: "Send",
      invariant: "limit",
      ...at("@invariant limit"),
    },
    { code: "W_REVIEW_WEAK", message: 'The review of contract "Send" found invariant `quota-error` unrelated: quota-error looked unrelated', contract: "Send", invariant: "quota-error", ...at("@invariant quota-error") },
    {
      code: "W_REVIEW_WEAK",
      message: 'The review of contract "Send" found invariant `sender-error` insufficient-context: sender-error looked insufficient-context',
      contract: "Send",
      invariant: "sender-error",
      ...at("@invariant sender-error"),
    },
    { code: "W_REVIEW_MISSING", message: 'Contract "Quota" has no recorded review. Run `design review Quota`, have the material reviewed, and record the verdict with `design review --record`.', contract: "Quota", invariant: undefined, ...inFixture(QUOTA, "Quota {") },
  ]);
  writeFile(root, ".design/config.json", JSON.stringify({ version: 1, review: "require" }));
  assert.equal(check(root).code, 1);
});

test("a verdict is refused when it is not about the designs as they are, and then nothing is recorded", (t) => {
  const root = extracted(t);
  const good = { contract: "Send", fingerprint: fingerprintOf(root, "Send"), findings: SEND_INVARIANTS.map((id) => finding(id)) };
  const refusals = (verdict: object) => {
    const { code, report } = record(root, { version: 1, verdicts: [verdict, good] });
    assert.deepEqual(report.recorded, []);
    return { code, codes: report.diagnostics.filter(isError).map(({ code }) => code), messages: report.diagnostics.filter(isError).map(({ message }) => message) };
  };
  assert.deepEqual(refusals({ ...good, contract: "Nobody" }).codes, ["E_REFERENCE_UNKNOWN"]);
  assert.deepEqual(refusals({ ...good, findings: [...good.findings, finding("nothing")] }).messages, ['The verdict for "Send" assesses invariants it does not have: `nothing`.']);
  assert.deepEqual(refusals({ ...good, findings: good.findings.slice(1) }).messages, ['The verdict for "Send" leaves invariants unassessed: `quota`.']);
  assert.deepEqual(refusals({ contract: "Sender", fingerprint: fingerprintOf(root, "Sender"), findings: [] }).messages, [
    'The verdict for "Sender" has no finding; a contract without invariants gets one about the contract as a whole.',
  ]);
  const shape = refusals({ ...good, findings: [{ invariant: "quota", assessment: "fine", reason: "" }] });
  assert.equal(shape.code, 2);
  assert.deepEqual(shape.codes, ["E_CONFIG"]);
  assert.equal(record(root, { version: 2 }).code, 2);
  assert.equal(record(root, "not an object").code, 2);
  assert.equal(fs.existsSync(path.join(root, REVIEW_FILE)), false, "nothing was recorded");

  const usage = cli(root, "review", "--record", VERDICTS, "Send");
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /--record takes the verdicts file only/);
  assert.match(cli(root, "check", "--record", VERDICTS).stderr, /--record is an option of the review command/);
});
