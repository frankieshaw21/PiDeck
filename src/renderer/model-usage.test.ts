import { strict as assert } from "node:assert";
import { test } from "node:test";
import { lastModelUsage, modelUsage } from "./model-usage.js";

test("reads provider usage from completed assistant messages", () => {
  const message = { role: "assistant", stopReason: "stop", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 } };
  assert.deepEqual(modelUsage(message), { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 });
  assert.deepEqual(lastModelUsage([message, { role: "user", content: "next" }]), modelUsage(message));
});

test("reports unavailable for failed, missing or unreported usage", () => {
  const zeros = { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(modelUsage(zeros), null);
  assert.equal(modelUsage({ role: "assistant", stopReason: "error", usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 } }), null);
  assert.equal(lastModelUsage([{ role: "assistant", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }, zeros]), null);
});
