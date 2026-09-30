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
  t.after(() => fs.rmSync(path.join(os.tmpdir(), `design-gate-${id}`), { force: true }));
  return id;
}

const gate = (root: string, input: object | string | undefined, ...args: string[]) =>
  cliWithStdin(root, typeof input === "object" ? JSON.stringify(input) : input, "gate", ...args);

test("the gate blocks on errors and on review findings, whatever the review level, and passes a clean check", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(cli(root, "extract").code, 0);
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

  editFile(root, "src/modules/campaigns/send.test.ts", (s) => s.replace("/** @covers sender-error */", "/** no cover */"));
  const error = gate(root, { session_id: id, stop_hook_active: false });
  assert.equal(error.code, 2);
  assert.match(error.stderr, /E_TEST_MISSING/);
  assert.match(error.stderr, /\(1 blocking\)/);
});

test("after MAX_BLOCKS blocks in one session the gate lets the agent stop, with the report; a pass resets the count", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(cli(root, "extract").code, 0);
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

test("the gate reads the hook's input leniently and takes the options of check", (t) => {
  const root = copyFixture(t, "vertical");
  assert.equal(cli(root, "extract").code, 0);
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
