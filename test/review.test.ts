import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
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

test("a packet holds the contract, its design, the designs it depends on, its implementations and its tests, each file once", (t) => {
  const root = copyFixture(t, "vertical");
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
      { path: CALLBACK_SENDER, role: "helper" },
      { path: MAIL, role: "design" },
      { path: QUOTA, role: "design" },
    ],
  );
  assert.equal(report.files.find((file) => file.path === SEND_TEST)?.text, readFile(root, SEND_TEST));

  const [packet] = report.contracts;
  assert.equal(report.contracts.length, 1);
  assert.equal(packet.contract, "Send");
  assert.equal(packet.module, "src/modules/campaigns");
  assert.deepEqual(packet.designs, [CAMPAIGNS]);
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
  // Nothing outside campaigns imports SendService; a file that does is listed, with its line.
  assert.deepEqual(packet.usedBy, []);
  writeFile(root, "src/modules/mail/digest.ts", 'import { SendService } from "../campaigns/send-service.ts";\n\nexport const digest = (service: SendService) => service.run("a", "text");\n');
  assert.deepEqual(review(root, "Send").report.contracts[0].usedBy, [{ file: "src/modules/mail/digest.ts", line: 1, names: ["SendService"], members: ["run"] }]);
  assert.ok(cli(root, "review", "Send").stdout.includes("- src/modules/mail/digest.ts:1 imports SendService and calls run — relies on the promises above"));
  fs.rmSync(path.join(root, "src/modules/mail/digest.ts"));

  // What the test file imports from the project is loaded with it, as a helper; what the implementation imports is only listed.
  assert.deepEqual(packet.helpers, [CALLBACK_SENDER]);
  assert.deepEqual(packet.unloaded, []);
  assert.deepEqual(report.files.find((file) => file.path === CALLBACK_SENDER)?.role, "helper");
  // No test file of the module is without declarations; one that is gets listed, with no claim about its content.
  assert.deepEqual(packet.untaggedTests, []);
  writeFile(root, "src/modules/campaigns/send.e2e.test.ts", 'import { it } from "node:test";\nit("real sending", () => { return; });\n');
  assert.deepEqual(review(root, "Send").report.contracts[0].untaggedTests, ["src/modules/campaigns/send.e2e.test.ts"]);
  assert.deepEqual(review(root, "Quota").report.contracts[0].untaggedTests, []);
  // The Sender warning is about a file of the packet.
  assert.deepEqual(packet.diagnostics.map(({ code }) => code), ["W_NO_INVARIANTS"]);
});

test("the fingerprint is of the contract, its module's prose, its implementations, its tests and what they import, and of nothing else", (t) => {
  const root = copyFixture(t, "vertical");
  const fingerprint = () => review(root, "Send").report.contracts[0].fingerprint;
  const first = fingerprint();
  assert.equal(fingerprint(), first);
  const sender = review(root, "Sender").report.contracts[0].fingerprint;

  // Not material: a test of another contract, a comment outside the tests of Send, the prose of another module's design, line endings.
  editFile(root, "src/modules/quota/quota.test.ts", (s) => `${s}// a change to a test of another contract\n`);
  editFile(root, SEND_TEST, (s) => `${s}// a comment after the tests of Send\n`);
  editFile(root, QUOTA, (s) => s.replace("# ", "# Модуль: "));
  editFile(root, SEND_TEST, (s) => s.replaceAll("\n", "\r\n"));
  editFile(root, CAMPAIGNS, (s) => s.replaceAll("\n", "\r\n"));
  assert.equal(fingerprint(), first);
  // Material: the prose of the contract's own module — the business rules a reviewer judges the tests against.
  editFile(root, CAMPAIGNS, (s) => s.replace("# ", "# Модуль: "));
  const afterProse = fingerprint();
  assert.notEqual(afterProse, first);
  assert.equal(review(root, "Send").report.files.find((file) => file.path === SEND_TEST)?.text.includes("\r"), false);

  // Material: a test declared for Send, the implementation, the contract's declaration (its doc comment included).
  editFile(root, SEND_TEST, (s) => s.replace('it("не передає повідомлення без квоти"', 'it("не передає повідомлення без квоти (edited)"'));
  const afterTest = fingerprint();
  assert.notEqual(afterTest, afterProse);
  editFile(root, SEND_SERVICE, (s) => s.replace('return "sent";', 'return "sent" as const;'));
  const afterImplementation = fingerprint();
  assert.notEqual(afterImplementation, afterTest);
  editFile(root, CAMPAIGNS, (s) => s.replace("@invariant limit За false", "@invariant limit За false (уточнено)"));
  assert.notEqual(fingerprint(), afterImplementation);
  // None of that is material of Sender.
  assert.equal(review(root, "Sender").report.contracts[0].fingerprint, sender);
});

test("the markdown document lists the contracts and every file once, in fences longer than any run of backticks inside", (t) => {
  const root = copyFixture(t, "vertical");
  editFile(root, SEND_TEST, (s) => `${s}// a comment with \`\`\`\` four backticks\n`);
  const { code, stdout } = cli(root, "review", "Send", "Quota");
  assert.equal(code, 0);
  assert.ok(stdout.startsWith("# Design review\n"));
  assert.equal(stdout.match(/^## Contract /gm)?.length, 2);
  assert.deepEqual(
    stdout.match(/^### src\/.*$/gm),
    [`### ${CAMPAIGNS} (design)`, `### ${SEND_SERVICE} (implementation)`, `### ${SEND_TEST} (test)`, `### ${CALLBACK_SENDER} (helper)`, `### ${MAIL} (design)`, "### src/modules/quota/memory-quota.ts (implementation)", `### ${QUOTA} (design)`, "### src/modules/quota/quota.test.ts (test)"],
  );
  assert.ok(stdout.includes("\n`````ts\n"), "fences are five backticks");
  assert.ok(!stdout.includes("\n````ts\n"));
  assert.ok(stdout.includes("- uses: Quota (src/modules/quota), Sender (src/modules/mail)"));
  assert.ok(stdout.includes("## Result format"));
  assert.ok(stdout.includes(`### Helpers loaded with the tests\n\n- ${CALLBACK_SENDER}`), "the helper the test imports is loaded and listed");
  // Files are printed with line numbers, so that evidence can name a line.
  assert.match(stdout, /\n\s*1 \| # Відправлення\n/);
  assert.match(stdout, /\n\s*1 \| import assert from "node:assert\/strict";\n/);
});

test("without names the contracts in need of a review are exported, which is all of them at first; an unknown name is an error", (t) => {
  const root = copyFixture(t, "vertical");
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
  const root = copyFixture(t, "vertical");
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

  writeFile(root, ".cage/config.json", "{ nope");
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
  // Evidence is null only for insufficient-context: every other finding names what it rests on.
  evidence: assessment === "insufficient-context" ? null : `${SEND_TEST}:9`,
  suggestedChange: null,
  ...extra,
});
const SEND_INVARIANTS = ["quota", "limit", "quota-error", "sender-error"];
/** The reason `finding(null)` writes: what a contract-level note is printed as. */
const DEFAULT_REASON = "the contract looked adequate";
const fingerprintOf = (root: string, name: string) => review(root, name).report.contracts[0].fingerprint;

test("a recorded verdict makes check content with the contract, and the review file says what was reviewed", (t) => {
  const root = copyFixture(t, "vertical");
  // Until something is recorded, every contract is reported; by default as a warning.
  const before = check(root);
  assert.equal(before.code, 0);
  assert.deepEqual(
    reviewDiagnostics(root).map(({ code, contract }) => ({ code, contract })),
    [{ code: "W_REVIEW_MISSING", contract: "Send" }, { code: "W_REVIEW_MISSING", contract: "Sender" }, { code: "W_REVIEW_MISSING", contract: "Quota" }],
  );
  assert.ok(before.report.diagnostics.find(({ code }) => code === "W_REVIEW_MISSING")?.message.includes("Run `cage review Send`"));
  // The design phase does not have the material of a review.
  assert.deepEqual(reviewDiagnostics(root, "--phase", "design"), []);

  const fingerprint = fingerprintOf(root, "Send");
  const recorded = record(root, { version: 1, verdicts: [{ contract: "Send", fingerprint, findings: SEND_INVARIANTS.map((id) => finding(id)) }] });
  assert.equal(recorded.code, 0);
  assert.deepEqual(recorded.report.recorded, [
    { module: "src/modules/campaigns", contract: "Send", fingerprint, assessments: { adequate: 4, weak: 0, unrelated: 0, "insufficient-context": 0 }, contractAssessments: { adequate: 0, weak: 0, unrelated: 0, "insufficient-context": 0 }, notes: [] },
  ]);
  assert.equal(cli(root, "review", "--record", VERDICTS).stdout, `✓ recorded  Send (4 adequate)\nreview --record: 1 recorded in ${REVIEW_FILE}; a reviewer's assessment, not a test run.\n`);
  // The verdicts file is named relative to the current directory, and appears as a project path in diagnostics.
  fs.mkdirSync(path.join(root, "out"));
  fs.renameSync(path.join(root, VERDICTS), path.join(root, "out", VERDICTS));
  assert.equal(cli(path.join(root, "out"), "review", "--record", VERDICTS, "--root", "..").code, 0);
  writeFile(root, "out/broken.json", "{ nope");
  const broken = cli(path.join(root, "out"), "review", "--record", "broken.json", "--root", "..", "--format", "json");
  assert.equal(broken.code, 2);
  assert.equal((JSON.parse(broken.stdout) as RecordReport).diagnostics[0].file, "out/broken.json");

  const file = JSON.parse(readFile(root, REVIEW_FILE));
  assert.deepEqual(Object.keys(file.reviews[0]), ["module", "contract", "fingerprint", "material", "findings"]);
  assert.deepEqual(Object.keys(file.reviews[0].material), [
    "contract",
    `design ${CAMPAIGNS}`,
    `implementation ${SEND_SERVICE}#SendService`,
    `test ${SEND_TEST}:чекає на підтвердження квоти до передачі повідомлення`,
    `test ${SEND_TEST}:не передає повідомлення без квоти`,
    `test ${SEND_TEST}:передає помилку квоти без звернення до транспорту`,
    `test ${SEND_TEST}:передає помилку транспорту`,
    // The tests of Send use the Sender implementation: what they observe depends on it.
    `dependency ${CALLBACK_SENDER}`,
  ]);
  assert.equal(file.reviews[0].fingerprint, fingerprint);

  assert.deepEqual(
    reviewDiagnostics(root).map(({ code, contract }) => ({ code, contract })),
    [{ code: "W_REVIEW_MISSING", contract: "Sender" }, { code: "W_REVIEW_MISSING", contract: "Quota" }],
  );
  // What is fresh is not exported again by default.
  assert.deepEqual(review(root).report.contracts.map(({ contract }) => contract), ["Sender", "Quota"]);

  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "require" }));
  const required = check(root);
  assert.equal(required.code, 1);
  assert.deepEqual(required.report.diagnostics.filter(isError).map(({ code, contract }) => ({ code, contract })), [{ code: "E_REVIEW_MISSING", contract: "Sender" }, { code: "E_REVIEW_MISSING", contract: "Quota" }]);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "off" }));
  assert.deepEqual(reviewDiagnostics(root), []);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "maybe" }));
  assert.match(check(root).report.diagnostics[0].message, /"review" must be "off", "warn" or "require"/);
});

test("a change to the material makes the review stale, naming the file, and the old verdict cannot be recorded", (t) => {
  const root = copyFixture(t, "vertical");
  const fingerprint = fingerprintOf(root, "Send");
  const verdicts = { version: 1, verdicts: [{ contract: "Send", fingerprint, findings: SEND_INVARIANTS.map((id) => finding(id)) }] };
  assert.equal(record(root, verdicts).code, 0);
  const reviewFile = readFile(root, REVIEW_FILE);

  editFile(root, SEND_TEST, (s) => s.replace('it("не передає повідомлення без квоти"', 'it("не передає повідомлення без квоти (edited)"'));
  const contractPosition = inFixture(CAMPAIGNS, "Send {");
  assert.deepEqual(reviewDiagnostics(root).filter(({ contract }) => contract === "Send"), [
    {
      code: "W_REVIEW_STALE",
      message: `The recorded review of contract "Send" is for other material; since then: test "не передає повідомлення без квоти (edited)" (${SEND_TEST}) is new, test "не передає повідомлення без квоти" (${SEND_TEST}) is gone. Review it again.`,
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

  // A recorded fingerprint that does not match its own digests is stale too, and the message says so.
  const tampered = JSON.parse(reviewFile);
  writeFile(root, REVIEW_FILE, JSON.stringify({ ...tampered, reviews: [{ ...tampered.reviews[0], fingerprint: "sha256:0" }] }));
  editFile(root, SEND_TEST, (s) => s.replace('it("не передає повідомлення без квоти (edited)"', 'it("не передає повідомлення без квоти"'));
  assert.match(reviewDiagnostics(root).find(({ contract }) => contract === "Send")?.message ?? "", /for other material; its recorded fingerprint does not match its files\. Review it again\./);
  writeFile(root, REVIEW_FILE, reviewFile);

  // A changed declaration names who outside the module relies on it.
  writeFile(root, "src/modules/mail/digest.ts", 'import { SendService } from "../campaigns/send-service.ts";\n\nexport const digest = (service: SendService) => service.run("a", "text");\n');
  editFile(root, CAMPAIGNS, (s) => s.replace("@invariant limit За false", "@invariant limit За false (уточнено)"));
  assert.match(reviewDiagnostics(root).find(({ contract }) => contract === "Send")?.message ?? "", /the contract declaration changed\. Review it again\. The contract changed and is used outside its module by src\/modules\/mail\/digest\.ts:1 \(run\): they rely on the old promise\./);
  editFile(root, CAMPAIGNS, (s) => s.replace("@invariant limit За false (уточнено)", "@invariant limit За false"));
  fs.rmSync(path.join(root, "src/modules/mail/digest.ts"));

  // The implementation is material; a file of another contract, or a comment next to the tests, is not.
  editFile(root, SEND_SERVICE, (s) => s.replace('return "sent";', 'return "sent" as const;'));
  assert.match(reviewDiagnostics(root).find(({ contract }) => contract === "Send")?.message ?? "", new RegExp(`since then: implementation SendService \\(${SEND_SERVICE}\\) changed`));
  assert.equal(record(root, { ...verdicts, verdicts: [{ ...verdicts.verdicts[0], fingerprint: fingerprintOf(root, "Send") }] }).code, 0);
  editFile(root, "src/modules/quota/quota.test.ts", (s) => `${s}// not material of Send\n`);
  editFile(root, SEND_TEST, (s) => `${s}// not material either\n`);
  assert.deepEqual(reviewDiagnostics(root).filter(({ contract }) => contract === "Send"), []);
});

test("findings other than adequate are reported where the invariant is, with the reason and the suggestion", (t) => {
  const root = copyFixture(t, "vertical");
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
  // A contract-level finding is not an assessment of an invariant: it is counted apart and printed, first sentence first,
  // led by its assessment when that is not adequate, since check reports it against the contract as a whole.
  const none = { adequate: 0, weak: 0, unrelated: 0, "insufficient-context": 0 };
  assert.deepEqual(recorded.report.recorded.map(({ contract, assessments, contractAssessments, notes }) => ({ contract, assessments, contractAssessments, notes })), [
    { contract: "Send", assessments: { adequate: 1, weak: 1, unrelated: 1, "insufficient-context": 1 }, contractAssessments: { ...none, weak: 1 }, notes: ["weak: no test runs two sends at once"] },
    { contract: "Sender", assessments: none, contractAssessments: { ...none, adequate: 1 }, notes: [DEFAULT_REASON] },
  ]);
  assert.deepEqual(cli(root, "review", "--record", VERDICTS).stdout.split("\n").slice(0, 2), ["! recorded  Send (1 adequate, 1 weak, 1 unrelated, 1 insufficient-context; the contract as a whole: 1 weak; 1 note)", "            note: weak: no test runs two sends at once"]);
  // The next packet of the contract repeats the note, so that an observation stays until the design's owner acts on it.
  assert.deepEqual(review(root, "Send").report.contracts[0].priorNotes, ["weak: no test runs two sends at once"]);
  assert.ok(cli(root, "review", "Send").stdout.includes("### Notes of the previous review\n\n- weak: no test runs two sends at once"));

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
    { code: "W_REVIEW_MISSING", message: 'Contract "Quota" has no recorded review. Run `cage review Quota`, have the material reviewed, and record the verdict with `cage review --record`.', contract: "Quota", invariant: undefined, ...inFixture(QUOTA, "Quota {") },
  ]);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "require" }));
  assert.equal(check(root).code, 1);
});

test("a verdict is refused when it is not about the designs as they are, and then nothing is recorded", (t) => {
  const root = copyFixture(t, "vertical");
  const good = { contract: "Send", fingerprint: fingerprintOf(root, "Send"), findings: SEND_INVARIANTS.map((id) => finding(id)) };
  const quota = { contract: "Quota", fingerprint: fingerprintOf(root, "Quota"), findings: ["accounts", "empty", "consume", "race"].map((id) => finding(id)) };
  // A sound verdict for another contract goes with each refused one: nothing of it is recorded either.
  const refusals = (verdict: object) => {
    const { code, report } = record(root, { version: 1, verdicts: [verdict, quota] });
    assert.deepEqual(report.recorded, []);
    return { code, codes: report.diagnostics.filter(isError).map(({ code }) => code), messages: report.diagnostics.filter(isError).map(({ message }) => message) };
  };
  assert.deepEqual(refusals({ ...good, contract: "Nobody" }).codes, ["E_REFERENCE_UNKNOWN"]);
  const twice = record(root, { version: 1, verdicts: [good, good] });
  assert.deepEqual(twice.report.diagnostics.map(({ message }) => message), ['There is more than one verdict for "Send"; one contract gets one verdict.']);
  assert.deepEqual(twice.report.recorded, []);
  assert.equal(record(root, { version: 1, verdicts: [] }).code, 2);
  assert.match(record(root, { version: 1, verdicts: [] }).report.diagnostics[0].message, /it has no verdict/);
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

test("a review of a contract that no longer exists is reported by check and removed by the next record", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(record(root, { version: 1, verdicts: [{ contract: "Sender", fingerprint: fingerprintOf(root, "Sender"), findings: [finding(null)] }] }).code, 0);
  // The contract moves to another module: its old entry answers to nothing.
  const mail = readFile(root, MAIL);
  const callbackSender = readFile(root, CALLBACK_SENDER);
  fs.rmSync(path.join(root, "src/modules/mail"), { recursive: true });
  writeFile(root, "src/modules/post/post.cage.mdx", mail);
  writeFile(root, "src/modules/post/callback-sender.ts", callbackSender);
  editFile(root, SEND_TEST, (s) => s.replace("../mail/", "../post/"));
  assert.deepEqual(
    reviewDiagnostics(root).filter(({ file }) => file === REVIEW_FILE).map(({ code, message }) => ({ code, message })),
    [{ code: "W_REVIEW_STALE", message: 'The review file has a review of contract "Sender" of src/modules/mail, which no longer exists there. `cage review --record` removes it.' }],
  );
  const withDeadEntry = readFile(root, REVIEW_FILE);
  const recorded = record(root, { version: 1, verdicts: [{ contract: "Sender", fingerprint: fingerprintOf(root, "Sender"), findings: [finding(null)] }] });
  assert.equal(recorded.code, 0);
  assert.deepEqual(recorded.report.removed, [{ module: "src/modules/mail", contract: "Sender" }]);
  assert.deepEqual(JSON.parse(readFile(root, REVIEW_FILE)).reviews.map((entry: { module: string }) => entry.module), ["src/modules/post"]);
  writeFile(root, REVIEW_FILE, withDeadEntry);
  assert.deepEqual(cli(root, "review", "--record", VERDICTS).stdout.split("\n").slice(0, 4), [
    "✓ recorded  Sender (no invariants; 1 note)",
    `            note: ${DEFAULT_REASON}`,
    "- removed   Sender (no longer in src/modules/mail)",
    `review --record: 1 recorded, 1 removed in ${REVIEW_FILE}; a reviewer's assessment, not a test run.`,
  ]);
});
