import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { PiRpcAdapter } from "./pi-rpc-adapter.js";
import type { RuntimeEvent } from "./types.js";

test("surfaces an unexpected Pi exit and rejects pending work", async () => {
  const adapter = new PiRpcAdapter({
    harnessSessionId: "crash-test",
    piSessionId: "crash-test",
    projectDir: process.cwd(),
    sessionDir: join(tmpdir(), "minimal-pi-crash-test"),
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

test("starts a Windows command shim from a path with spaces", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi shim test "));
  const shim = join(root, "pi.cmd");
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${resolve("fixtures/fake-pi-crash.mjs")}" %*\r\n`);
  const adapter = new PiRpcAdapter({
    harnessSessionId: "shim-test",
    piSessionId: "shim-test",
    projectDir: process.cwd(),
    sessionDir: join(root, "session data"),
    piPath: shim,
  });
  try {
    await adapter.start();
    await assert.rejects(adapter.prompt("crash"), /code=42/);
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
