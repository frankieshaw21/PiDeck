import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { PiRpcAdapter } from "./pi-rpc-adapter.js";
import type { RuntimeEvent } from "./types.js";

test("surfaces an unexpected Pi exit and rejects pending work", async () => {
  const adapter = new PiRpcAdapter({
    harnessSessionId: "crash-test",
    piSessionId: "crash-test",
    projectDir: process.cwd(),
    sessionDir: "/tmp/minimal-pi-crash-test",
    piPath: process.execPath,
    piExecutableArgs: [resolve("fixtures/fake-pi-crash.mjs")],
  });
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.start();
  await assert.rejects(adapter.prompt("crash"), /code=42/);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.ok(events.some((event) => event.record.type === "runtime_process_exit" && event.record.code === 42));
  await adapter.dispose();
});
