import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MemoryQuota } from "./memory-quota.ts";

/** @tests Quota */
describe("MemoryQuota", () => {
  /** @covers accounts */
  it("зберігає незалежний залишок акаунтів", async () => {
    const quota = new MemoryQuota({ a: 1, b: 1 });
    assert.equal(await quota.take("a"), true);
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("b"), true);
  });

  /** @covers empty */
  it("відмовляє для нульового та невідомого залишку", async () => {
    const quota = new MemoryQuota({ a: 0 });
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("a"), false);
    assert.equal(await quota.take("unknown"), false);
  });

  /** @covers consume */
  it("витрачає одну одиницю на успішний виклик", async () => {
    const quota = new MemoryQuota({ a: 1 });
    assert.equal(await quota.take("a"), true);
    assert.equal(await quota.take("a"), false);
  });

  /** @covers race */
  it("не перевищує залишок при паралельних викликах", async () => {
    const quota = new MemoryQuota({ a: 1 });
    const results = await Promise.all([quota.take("a"), quota.take("a")]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await quota.take("a"), false);
  });
});
