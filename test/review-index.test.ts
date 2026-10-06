import assert from "node:assert/strict";
import { test } from "node:test";
import type { ReviewIndex, ReviewReport } from "../src/review.ts";
import { CAMPAIGNS, cli, copyFixture, editFile, find, inFixture, MAIL, QUOTA, readFile, writeFile } from "./helpers.ts";

const SEND_TEST = "src/modules/campaigns/send.test.ts";
const SEND_SERVICE = "src/modules/campaigns/send-service.ts";
const CALLBACK_SENDER = "src/modules/mail/callback-sender.ts";

const index = (root: string, ...args: string[]) => JSON.parse(cli(root, "review", "--format", "json", ...args).stdout) as ReviewIndex;
const packet = (root: string, ...args: string[]) => JSON.parse(cli(root, "review", "--format", "json", ...args).stdout) as ReviewReport;

/** Records an adequate verdict for every invariant of the named contracts, for their material as it is now; `evidence` may name a line per invariant. */
function recordAdequate(root: string, names: string[] | string, evidence: (invariant: string | null) => string = () => `${SEND_TEST}:9`): void {
  const verdicts = packet(root, ...(typeof names === "string" ? [names] : names)).contracts.map(({ contract, fingerprint, invariants }) => ({
    contract,
    fingerprint,
    findings: (invariants.length === 0 ? [null] : invariants.map(({ id }) => id)).map((invariant) => ({ invariant, assessment: "adequate", reason: `${invariant ?? "the contract"} is checked.`, evidence: evidence(invariant), suggestedChange: null })),
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(root, "review", "--record", "verdicts.json").code, 0);
}

/** @tests Cli
 * @covers review-index review-touched */
test("without names review is an index: which contracts need a review, what changed and which invariants it touches", (t) => {
  const root = copyFixture(t, "vertical");
  // Nothing recorded: every contract needs a review, and there is nothing to compare with.
  const first = index(root);
  assert.equal(first.selection, "needed");
  assert.deepEqual(
    first.contracts.map(({ contract, status, invariants, touched, changed, files }) => ({ contract, status, invariants, touched, changed, files })),
    [
      { contract: "Send", status: "none", invariants: ["quota", "limit", "quota-error", "sender-error"], touched: null, changed: [], files: 5 },
      { contract: "Sender", status: "none", invariants: [], touched: null, changed: [], files: 2 },
      { contract: "Quota", status: "none", invariants: ["accounts", "empty", "consume", "race"], touched: null, changed: [], files: 3 },
    ],
  );
  assert.match(first.contracts[0].fingerprint, /^sha256:[0-9a-f]{64}$/);
  const text = cli(root, "review").stdout;
  assert.match(text, /^# Review index: 3 contracts need a review\n\n- Send /);
  assert.match(text, /^- Send \(src\/modules\/campaigns\): no review; 4 invariants, 5 files$/m);
  assert.match(text, /^- Sender \(src\/modules\/mail\): no review; 0 invariants, 2 files; W_NO_INVARIANTS$/m);
  // No file text in the index.
  assert.ok(!text.includes("```"));

  recordAdequate(root, ["Send", "Quota"]);
  // Fresh verdicts are left out by default and listed with --all.
  assert.deepEqual(index(root).contracts.map(({ contract }) => contract), ["Sender"]);
  const all = index(root, "--all");
  assert.equal(all.selection, "all");
  assert.deepEqual(all.contracts.map(({ contract, status }) => `${contract} ${status}`), ["Send current", "Sender none", "Quota current"]);
  assert.match(cli(root, "review", "--all").stdout, /^# Review index: 3 contracts, 1 in need of a review$/m);
  assert.match(cli(root, "review", "--all").stdout, /^- Send \(src\/modules\/campaigns\): reviewed, current; 4 invariants, 5 files$/m);

  // One test's body changes: the review of Send is outdated by that one part, which touches the invariant the test covers.
  editFile(root, SEND_TEST, (s) => s.replace('assert.equal(await service.run("a", "hello"), "limited");', 'assert.equal(await service.run("a", "hello"), "limited"); // edited'));
  const [send] = index(root).contracts;
  assert.equal(send.status, "outdated");
  assert.deepEqual(send.changed, [{ part: `test ${SEND_TEST}:не передає повідомлення без квоти`, kind: "test", change: "changed", file: SEND_TEST, line: inFixture(SEND_TEST, 'it("не передає').line, name: "не передає повідомлення без квоти" }]);
  assert.deepEqual(send.touched, ["limit"]);
  const outdated = cli(root, "review").stdout;
  assert.match(outdated, /^- Send \(src\/modules\/campaigns\): outdated, 1 part changed, touching limit; 4 invariants, 5 files$/m);
  assert.match(outdated, /^  - test "не передає повідомлення без квоти" changed \(src\/modules\/campaigns\/send\.test\.ts:\d+\)$/m);

  // The implementation changes too: everything is touched; a title changes: the old test is gone, the new one is new.
  // A comment inside the class is a change of the implementation's text; one between the tag and the class would untag it.
  editFile(root, SEND_SERVICE, (s) => s.replace(/export class SendService([^{]*)\{/, "export class SendService$1{ // touched"));
  editFile(root, SEND_TEST, (s) => s.replace('it("передає помилку транспорту"', 'it("передає помилку транспорту (renamed)"'));
  const [again] = index(root).contracts;
  assert.deepEqual(
    again.changed.map(({ kind, change, name }) => ({ kind, change, name })),
    [
      { kind: "implementation", change: "changed", name: "SendService" },
      { kind: "test", change: "changed", name: "не передає повідомлення без квоти" },
      { kind: "test", change: "new", name: "передає помилку транспорту (renamed)" },
      { kind: "test", change: "gone", name: "передає помилку транспорту" },
    ],
  );
  assert.deepEqual(again.touched, ["quota", "limit", "quota-error", "sender-error"]);
  assert.match(cli(root, "review").stdout, /outdated, 4 parts changed, touching every invariant/);
});

/** @tests Cli
 * @covers review-packet */
test("a named packet carries the changed lines of an outdated review with the previous findings; --files all and none change what comes along", (t) => {
  const root = copyFixture(t, "vertical");
  // Without a review to compare with, everything comes along, as before.
  const fresh = packet(root, "Send");
  assert.equal(fresh.included, "changed");
  assert.deepEqual(fresh.excerpts, []);
  assert.deepEqual(fresh.files.map(({ path }) => path), [CAMPAIGNS, SEND_SERVICE, SEND_TEST, CALLBACK_SENDER, MAIL, QUOTA]);
  assert.deepEqual(fresh.contracts[0].changed, []);
  assert.equal(fresh.contracts[0].touched, null);
  assert.deepEqual(fresh.contracts[0].invariants.map(({ touched, prior }) => ({ touched, prior })), Array(4).fill({ touched: null, prior: [] }));

  recordAdequate(root, "Send");
  editFile(root, SEND_TEST, (s) => s.replace('assert.equal(await service.run("a", "hello"), "limited");', 'assert.equal(await service.run("a", "hello"), "limited"); // edited'));
  const changed = packet(root, "Send");
  const [send] = changed.contracts;
  assert.equal(send.recordedReview.status, "outdated");
  assert.deepEqual(send.touched, ["limit"]);
  assert.deepEqual(
    send.invariants.map(({ id, touched, prior }) => ({ id, touched, prior: prior.map(({ assessment }) => assessment) })),
    [
      { id: "quota", touched: false, prior: ["adequate"] },
      { id: "limit", touched: true, prior: ["adequate"] },
      { id: "quota-error", touched: false, prior: ["adequate"] },
      { id: "sender-error", touched: false, prior: ["adequate"] },
    ],
  );
  // The excerpt is the test statement and connecting imports, numbered as in the file; nothing is included whole.
  assert.deepEqual(changed.files, []);
  assert.equal(changed.excerpts.length, 1);
  const [excerpt] = changed.excerpts;
  assert.equal(excerpt.part, `test ${SEND_TEST}:не передає повідомлення без квоти`);
  assert.equal(excerpt.file, SEND_TEST);
  const source = readFile(root, SEND_TEST);
  const start = find(source, "/** @covers limit */").line;
  assert.equal(excerpt.pieces.length, 5);
  assert.deepEqual(excerpt.pieces.slice(1).map((piece) => piece.text.trim()), source.split("\n").filter((line) => line.startsWith("import ") && !line.startsWith("import type ")));
  assert.equal(excerpt.pieces[0].startLine, start);
  assert.ok(excerpt.pieces[0].endLine > start);
  assert.equal(excerpt.pieces[0].text, source.split("\n").slice(start - 1, excerpt.pieces[0].endLine).join("\n"));
  assert.ok(excerpt.pieces[0].text.includes("// edited"));
  assert.ok(excerpt.pieces[0].text.trimEnd().endsWith("});"));

  const markdown = cli(root, "review", "Send").stdout;
  assert.match(markdown, /^review: outdated, 1 part changed, touching 1 of 4 invariants$/m);
  assert.match(markdown, /^## Changed\n- test "не передає повідомлення без квоти" changed \(src\/modules\/campaigns\/send\.test\.ts:\d+\)\ntouches: limit \(judge afresh\); quota, quota-error, sender-error \(confirm or revise\)$/m);
  assert.match(markdown, /^  recorded: adequate, "limit is checked\." \(src\/modules\/campaigns\/send\.test\.ts:9\), changed$/m);
  assert.match(markdown, /^  recorded: adequate, "quota is checked\." \(src\/modules\/campaigns\/send\.test\.ts:9\), unchanged$/m);
  assert.match(markdown, new RegExp(`^### src/modules/campaigns/send\\.test\\.ts:${start}-${excerpt.pieces[0].endLine}, `, "m"));
  // `<line> | ` and then the line as written, with its own indentation.
  assert.match(markdown, new RegExp(`^${start} \\| {3}/\\*\\* @covers limit \\*/$`, "m"));
  assert.ok(!markdown.includes("## Files"));
  assert.ok(!markdown.includes(`### ${SEND_TEST} (test)`));
  // No instruction in the packet: that is the skill's. The verdict template closes it, with the fingerprint filled in.
  assert.ok(!markdown.includes("You are reviewing"));
  assert.match(markdown, new RegExp(`^## Verdict\\n.*\\n\\{"version":1,"verdicts":\\[\\{"contract":"Send","fingerprint":"${send.fingerprint}"`, "m"));

  // --files all: every file whole, no excerpts; --files none: neither.
  const all = packet(root, "Send", "--files", "all");
  assert.equal(all.included, "all");
  assert.deepEqual(all.excerpts, []);
  assert.deepEqual(all.files.map(({ path }) => path), [CAMPAIGNS, SEND_SERVICE, SEND_TEST, CALLBACK_SENDER, MAIL, QUOTA]);
  const none = packet(root, "Send", "--files", "none");
  assert.equal(none.included, "none");
  assert.deepEqual(none.files, []);
  assert.deepEqual(none.excerpts, []);
  const bare = cli(root, "review", "Send", "--files", "none").stdout;
  assert.ok(!bare.includes("## Files"));
  assert.ok(!bare.includes("## Changed material"));

  // A changed design document, or dependency, comes whole: there is no smaller part to show.
  editFile(root, CAMPAIGNS, (s) => s.replace("# ", "# Campaigns: "));
  editFile(root, CALLBACK_SENDER, (s) => `${s}\n// touched\n`);
  const whole = packet(root, "Send");
  assert.deepEqual(whole.contracts[0].changed.map(({ kind, change, file }) => ({ kind, change, file })), [
    { kind: "design", change: "changed", file: CAMPAIGNS },
    { kind: "test", change: "changed", file: SEND_TEST },
    { kind: "dependency", change: "changed", file: CALLBACK_SENDER },
  ]);
  assert.deepEqual(whole.contracts[0].touched, ["quota", "limit", "quota-error", "sender-error"]);
  assert.deepEqual(whole.files.map(({ path, role }) => `${path} ${role}`), [CAMPAIGNS + " design", CALLBACK_SENDER + " helper"]);
  assert.equal(whole.excerpts.length, 1);
});

/** @tests Cli
 * @covers review-index */
test("the index keeps every error in view: a broken review file is named, not only counted", (t) => {
  const root = copyFixture(t, "vertical");
  writeFile(root, ".cage/review.json", "{ nope");
  const run = cli(root, "review");
  assert.equal(run.code, 2);
  assert.match(run.stdout, /^- Send \(src\/modules\/campaigns\): not known \(the review file cannot be used\); 4 invariants, 5 files$/m);
  assert.match(run.stdout, /^- E_CONFIG review file not usable: .* \(\.cage\/review\.json\)$/m);
});

test("--files goes with the names of contracts only, and takes changed, all or none", (t) => {
  const root = copyFixture(t, "vertical");
  assert.match(cli(root, "review", "--files", "all").stderr, /--files is an option of review with the names of contracts\./);
  assert.match(cli(root, "review", "--all", "--files", "all").stderr, /--files is an option of review with the names of contracts\./);
  assert.match(cli(root, "review", "--record", "v.json", "--files", "all").stderr, /--files is an option of review with the names of contracts\./);
  assert.match(cli(root, "check", "--files", "all").stderr, /--files is an option of review with the names of contracts\./);
  assert.match(cli(root, "review", "Send", "--files", "some").stderr, /Unknown --files mode "some"; expected changed, all or none\./);
  assert.equal(cli(root, "review", "Send", "--files", "changed").code, 0);
});

/** @tests Cli
 * @covers review-touched */
test("touched is conservative where the record cannot tell: a reorder, a finding resting on a changed test, a coverage lost", (t) => {
  // Two tests swap places: every digest matches, the fingerprint does not. Nothing can be told apart, so everything is.
  const reordered = copyFixture(t, "vertical");
  recordAdequate(reordered, "Send");
  editFile(reordered, SEND_TEST, (s) => {
    const limit = s.indexOf("  /** @covers limit */");
    const quotaError = s.indexOf("  /** @covers quota-error */");
    const senderError = s.indexOf("  /** @covers sender-error */");
    return s.slice(0, limit) + s.slice(quotaError, senderError) + s.slice(limit, quotaError) + s.slice(senderError);
  });
  const [swapped] = index(reordered).contracts;
  assert.equal(swapped.status, "outdated");
  assert.deepEqual(swapped.changed, []);
  assert.deepEqual(swapped.touched, ["quota", "limit", "quota-error", "sender-error"]);
  assert.match(cli(reordered, "review").stdout, /outdated: no part differs, the fingerprint does/);
  const whole = packet(reordered, "Send");
  assert.equal(whole.files.length, 6);
  assert.deepEqual(whole.excerpts, []);
  assert.ok(whole.contracts[0].invariants.every(({ touched }) => touched === true));
  const text = cli(reordered, "review", "Send").stdout;
  assert.match(text, /^review: outdated: no part differs, the fingerprint does \(reordered, or the record edited\)$/m);
  assert.match(text, /^- no part differs by its digest; every file is included, judge every invariant afresh$/m);
  assert.doesNotMatch(text, /touches no invariant/);

  // A finding whose evidence points into the lines of a changed test rested on it: the invariant is touched although the test covers another one.
  const cited = copyFixture(t, "vertical");
  const lineOf = (needle: string) => find(readFile(cited, SEND_TEST), needle).line;
  const own: Record<string, number> = { quota: lineOf('it("чекає'), limit: lineOf('it("не передає'), "quota-error": lineOf('it("передає помилку квоти'), "sender-error": lineOf('it("передає помилку транспорту') };
  // sender-error's evidence cites the quota test; the others cite their own.
  recordAdequate(cited, "Send", (invariant) => `${SEND_TEST}:${invariant === "sender-error" ? own.quota + 3 : own[invariant!]}`);
  editFile(cited, SEND_TEST, (s) => s.replace('assert.deepEqual(delivered, ["hello"]);', 'assert.deepEqual(delivered, ["hello"]); // edited'));
  const [resting] = index(cited).contracts;
  assert.deepEqual(resting.changed.map(({ name }) => name), ["чекає на підтвердження квоти до передачі повідомлення"]);
  assert.deepEqual(resting.touched, ["quota", "sender-error"]);

  // A test re-tagged away from the only invariant it covered: that invariant has no test now, and is touched.
  const retagged = copyFixture(t, "vertical");
  recordAdequate(retagged, "Send");
  editFile(retagged, SEND_TEST, (s) => s.replace("/** @covers limit */", "/** @covers quota */"));
  const [lost] = index(retagged).contracts;
  assert.deepEqual(lost.changed.map(({ name }) => name), ["не передає повідомлення без квоти"]);
  assert.deepEqual(lost.touched, ["quota", "limit"]);
  const [send] = packet(retagged, "Send").contracts;
  assert.deepEqual(send.invariants.map(({ id, touched, tests }) => ({ id, touched, tests: tests.length })), [
    { id: "quota", touched: true, tests: 2 },
    { id: "limit", touched: true, tests: 0 },
    { id: "quota-error", touched: false, tests: 1 },
    { id: "sender-error", touched: false, tests: 1 },
  ]);
});
