import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ReviewReport } from "../src/review.ts";
import { CAMPAIGNS, cli, copyFixture, editFile, inFixture, MAIL, QUOTA, readFile, snapshot, writeFile } from "./helpers.ts";

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

test("without names every contract is reviewed; an unknown name is an error", (t) => {
  const root = extracted(t);
  const all = review(root);
  assert.equal(all.code, 0);
  assert.equal(all.report.selection, "all");
  assert.deepEqual(all.report.contracts.map(({ contract, module }) => `${module} ${contract}`), ["src/modules/campaigns Send", "src/modules/mail Sender", "src/modules/quota Quota"]);
  assert.deepEqual(review(root, "--all").report.contracts.length, 3);

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
