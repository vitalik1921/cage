import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryQuota } from "./memory-quota.ts";

/** @tests Quota */
describe("MemoryQuota", () => {
  /** @covers empty */
  it("refuses when nothing is left", async () => {
    const quota = new MemoryQuota({ a: 0 });
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("unknown"), false);
  });

  /** @covers consume */
  it("takes exactly one send", async () => {
    const quota = new MemoryQuota({ a: 2, b: 1 });
    assert.equal(await quota.take("a"), true);
    assert.equal(await quota.take("a"), true);
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("b"), true);
    assert.equal(await quota.take("b"), false);
  });
});
