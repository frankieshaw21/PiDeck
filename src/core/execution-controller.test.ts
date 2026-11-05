import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionController } from "./execution-controller.js";

test("enforces max concurrency and releases queued work", async () => {
  const states: string[] = [];
  const controller = new ExecutionController({ maxConcurrent: 2, onStateChange: (id, state) => states.push(`${id}:${state}`) });
  const a = await controller.acquire({ sessionId: "a", projectDir: "/p", intent: "analysis" });
  const b = await controller.acquire({ sessionId: "b", projectDir: "/p", intent: "analysis" });
  let cStarted = false;
  const cPromise = controller.acquire({ sessionId: "c", projectDir: "/p", intent: "analysis" }).then((lease) => { cStarted = true; return lease; });
  await Promise.resolve();
  assert.equal(cStarted, false);
  a.release();
  const c = await cPromise;
  assert.equal(cStarted, true);
  b.release();
  c.release();
  assert.deepEqual(controller.snapshot(), { active: [], queued: [] });
  assert.ok(states.includes("c:Queued"));
});

test("allows analysis but serializes writers in the same project", async () => {
  const controller = new ExecutionController({ maxConcurrent: 3 });
  const writerA = await controller.acquire({ sessionId: "wa", projectDir: "/p", intent: "write" });
  const analysis = await controller.acquire({ sessionId: "r", projectDir: "/p", intent: "analysis" });
  let writerBStarted = false;
  const writerBPromise = controller.acquire({ sessionId: "wb", projectDir: "/p", intent: "write" }).then((lease) => { writerBStarted = true; return lease; });
  await Promise.resolve();
  assert.equal(writerBStarted, false);
  writerA.release();
  const writerB = await writerBPromise;
  assert.equal(writerBStarted, true);
  analysis.release();
  writerB.release();
});

test("cancels queued work without touching active work", async () => {
  const controller = new ExecutionController({ maxConcurrent: 1 });
  const active = await controller.acquire({ sessionId: "active", projectDir: "/p", intent: "analysis" });
  const queued = controller.acquire({ sessionId: "queued", projectDir: "/p", intent: "analysis" });
  assert.equal(controller.cancelQueued("queued"), true);
  await assert.rejects(queued, /cancelled/);
  assert.equal(controller.isActive("active"), true);
  active.release();
});
