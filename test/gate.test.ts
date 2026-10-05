import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { MAX_BLOCKS } from "../src/gate.ts";
import { cli, cliWithStdin, copyFixture, editFile, writeFile } from "./helpers.ts";

/** A session of its own, so that the block counter of another test or run is not this one's. */
function session(t: TestContext): string {
  const id = `test-${crypto.randomBytes(6).toString("hex")}`;
  t.after(() => {
    for (const name of counters(id)) fs.rmSync(path.join(os.tmpdir(), name), { force: true });
  });
  return id;
}

/** The block counters of a session, one per project it stopped at. */
const counters = (id: string) => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`cage-gate-${id}-`));

const gate = (root: string, input: object | string | undefined, ...args: string[]) =>
  cliWithStdin(root, typeof input === "object" ? JSON.stringify(input) : input, "gate", ...args);

test("the gate blocks on errors and on missing reviews, whatever the review level, and passes a clean check", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);

  // Warnings about reviews are not errors of `check`, and still block the gate.
  assert.equal(cli(root, "check").code, 0);
  const blocked = gate(root, { session_id: id, stop_hook_active: false });
  assert.equal(blocked.code, 2);
  assert.equal(blocked.stdout, "");
  assert.match(blocked.stderr, /W_REVIEW_MISSING: Contract "Send" has no recorded review/);
  assert.match(blocked.stderr, /`cage check` is not clean \(3 blocking\)\. Fix what it reports before stopping\./);
  assert.match(blocked.stderr, /`cage review` lists what needs a review and what changed; `cage review <Name>` gives one contract's material/);

  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "off" }));
  const clean = gate(root, { session_id: id, stop_hook_active: false });
  assert.equal(clean.code, 0);
  assert.equal(clean.stderr, "");

  // Code the design does not cover blocks only when coverage is required: a warning lets the agent stop, an error does not.
  writeFile(root, "src/modules/mail/extra.ts", "export class Extra {}\n");
  assert.equal(gate(root, { session_id: id, stop_hook_active: false }).code, 0);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "off", coverage: "require" }));
  const uncovered = gate(root, { session_id: id, stop_hook_active: false });
  assert.equal(uncovered.code, 2);
  assert.match(uncovered.stderr, /E_NOT_DESIGNED: Exported class "Extra"/);
  fs.rmSync(path.join(root, "src/modules/mail/extra.ts"));
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "off" }));

  editFile(root, "src/modules/campaigns/send.test.ts", (s) => s.replace("/** @covers sender-error */", "/** no cover */"));
  const error = gate(root, { session_id: id, stop_hook_active: false });
  assert.equal(error.code, 2);
  assert.match(error.stderr, /E_TEST_MISSING/);
  assert.match(error.stderr, /\(1 blocking\)/);
});

test("a weak finding blocks the gate only where reviews are required; a missing or stale review blocks at any level", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);
  // Record a verdict for every contract, with one weak finding on Send.
  const index = JSON.parse(cli(root, "review", "--all", "--format", "json").stdout) as { contracts: { contract: string; fingerprint: string; invariants: string[] }[] };
  const verdicts = index.contracts.map(({ contract, fingerprint, invariants }) => ({
    contract,
    fingerprint,
    // A contract without invariants gets one finding about the contract as a whole.
    findings: (invariants.length === 0 ? [null] : invariants).map((id, index) => ({
      invariant: id,
      assessment: contract === "Send" && index === 0 ? "weak" : "adequate",
      reason: "judged.",
      evidence: "src/modules/campaigns/send.test.ts:1",
      suggestedChange: null,
    })),
  }));
  writeFile(root, "verdicts.json", JSON.stringify({ version: 1, verdicts }));
  assert.equal(cli(root, "review", "--record", path.join(root, "verdicts.json")).code, 0);

  // Under "warn" the weak finding is reported and the agent may stop.
  const warned = gate(root, { session_id: id });
  assert.equal(warned.code, 0);
  assert.match(cli(root, "check").stdout, /W_REVIEW_WEAK/);

  // Under "require" it is an error and blocks, with the hint for it.
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "require" }));
  const required = gate(root, { session_id: id });
  assert.equal(required.code, 2);
  assert.match(required.stderr, /E_REVIEW_WEAK/);
  assert.match(required.stderr, /For E_REVIEW_WEAK: improve the test or the design/);

  // A change to the material makes the review stale, which blocks under "warn" too.
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1 }));
  editFile(root, "src/modules/campaigns/send.test.ts", (s) => s.replace("/** @covers sender-error */", "/**\n * @covers sender-error\n */"));
  editFile(root, "src/modules/campaigns/send-service.ts", (s) => `${s}\n`.replace("export class", "/* touched */\nexport class"));
  const stale = gate(root, { session_id: id });
  assert.equal(stale.code, 2);
  assert.match(stale.stderr, /W_REVIEW_STALE/);
  assert.doesNotMatch(stale.stderr, /For E_REVIEW_WEAK/);
});

test("after MAX_BLOCKS blocks in one session the gate lets the agent stop, with the report; a pass resets the count", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);
  const attempt = (active: boolean) => gate(root, { session_id: id, stop_hook_active: active });

  assert.equal(attempt(false).code, 2);
  for (let block = 1; block < MAX_BLOCKS; block += 1) assert.equal(attempt(true).code, 2);
  const released = attempt(true);
  assert.equal(released.code, 0);
  assert.match(released.stderr, new RegExp(`still fails after ${MAX_BLOCKS} attempts; letting the agent stop`));
  assert.match(released.stderr, /W_REVIEW_MISSING/);
  // Only a stop that follows a block counts as the agent giving up; a fresh stop blocks again.
  assert.equal(attempt(false).code, 2);

  // Another session starts from zero.
  const other = session(t);
  assert.equal(gate(root, { session_id: other, stop_hook_active: true }).code, 2);

  // A clean check forgets the count.
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "off" }));
  assert.equal(attempt(true).code, 0);
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, review: "warn" }));
  assert.equal(attempt(true).code, 2);
});

test("a project without any design yet passes the gate: right after init there is nothing to hold the agent to", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);
  for (const module of ["campaigns", "mail", "quota"]) fs.rmSync(path.join(root, "src/modules", module, `${module}.cage.mdx`));
  assert.match(cli(root, "check").stdout, /E_NO_DESIGNS/);
  const result = gate(root, { session_id: id });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "cage gate: no *.cage.mdx design yet, nothing to check.\n");
  assert.deepEqual(counters(id), []);
});

test("a block counter of a session a day old is swept by the next run; a fresh one is kept", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);
  const old = path.join(os.tmpdir(), `cage-gate-test-old-${id}`);
  const fresh = path.join(os.tmpdir(), `cage-gate-test-fresh-${id}`);
  t.after(() => fs.rmSync(old, { force: true }));
  t.after(() => fs.rmSync(fresh, { force: true }));
  fs.writeFileSync(old, "1");
  fs.writeFileSync(fresh, "1");
  const yesterday = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, yesterday, yesterday);
  gate(root, { session_id: id });
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(fresh));
});

test("the gate reads the hook's input leniently and takes the options of check", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);
  assert.equal(gate(root, "not json").code, 2);
  assert.equal(gate(root, undefined).code, 2);
  assert.equal(gate(root, { session_id: id, stop_hook_active: "yes" }).code, 2);
  assert.match(gate(root, { session_id: id }, "--format", "json").stderr, /gate has no --format/);
  assert.equal(gate(root, { session_id: id }, "--format", "json").code, 2);
  // A configuration problem is reported the way check reports it, and blocks.
  writeFile(root, ".cage/config.json", "{ nope");
  assert.match(gate(root, { session_id: id }).stderr, /E_CONFIG/);
});
