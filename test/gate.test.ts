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
  t.after(() => fs.rmSync(path.join(os.tmpdir(), `cage-gate-${id}`), { force: true }));
  return id;
}

const gate = (root: string, input: object | string | undefined, ...args: string[]) =>
  cliWithStdin(root, typeof input === "object" ? JSON.stringify(input) : input, "gate", ...args);

test("the gate blocks on errors and on review findings, whatever the review level, and passes a clean check", (t) => {
  const root = copyFixture(t, "vertical");
  const id = session(t);

  // Warnings about reviews are not errors of `check`, and still block the gate.
  assert.equal(cli(root, "check").code, 0);
  const blocked = gate(root, { session_id: id, stop_hook_active: false });
  assert.equal(blocked.code, 2);
  assert.equal(blocked.stdout, "");
  assert.match(blocked.stderr, /W_REVIEW_MISSING: Contract "Send" has no recorded review/);
  assert.match(blocked.stderr, /`cage check` is not clean \(3 blocking\)\. Fix what it reports before stopping\./);
  assert.match(blocked.stderr, /run `cage review`, read the material/);

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
  assert.ok(!fs.existsSync(path.join(os.tmpdir(), `cage-gate-${id}`)));
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
