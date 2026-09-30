import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SendService } from "./send-service.ts";
import { CallbackSender } from "../mail/callback-sender.ts";

/** @tests Send */
describe("SendService", () => {
  /** @covers quota */
  it("чекає на підтвердження квоти до передачі повідомлення", async () => {
    let release!: (allowed: boolean) => void;
    const permission = new Promise<boolean>((resolve) => { release = resolve; });
    const delivered: string[] = [];
    const quota = { take: async (_accountId: string) => permission };
    const sender = new CallbackSender(async (text) => { delivered.push(text); });
    const service = new SendService(quota, sender);
    const pending = service.run("a", "hello");

    await Promise.resolve();
    assert.deepEqual(delivered, []);
    release(true);
    assert.equal(await pending, "sent");
    assert.deepEqual(delivered, ["hello"]);
  });

  /** @covers limit */
  it("не передає повідомлення без квоти", async () => {
    let calls = 0;
    const quota = { take: async (_accountId: string) => false };
    const sender = new CallbackSender(async () => { calls++; });
    const service = new SendService(quota, sender);
    assert.equal(await service.run("a", "hello"), "limited");
    assert.equal(calls, 0);
  });

  /** @covers quota-error */
  it("передає помилку квоти без звернення до транспорту", async () => {
    const error = new Error("quota unavailable");
    let calls = 0;
    const quota = { take: async (_accountId: string): Promise<boolean> => { throw error; } };
    const sender = new CallbackSender(async () => { calls++; });
    const service = new SendService(quota, sender);
    await assert.rejects(service.run("a", "hello"), (actual) => actual === error);
    assert.equal(calls, 0);
  });

  /** @covers sender-error */
  it("передає помилку транспорту", async () => {
    const error = new Error("transport unavailable");
    const quota = { take: async (_accountId: string) => true };
    const sender = new CallbackSender(async () => { throw error; });
    const service = new SendService(quota, sender);
    await assert.rejects(service.run("a", "hello"), (actual) => actual === error);
  });
});
