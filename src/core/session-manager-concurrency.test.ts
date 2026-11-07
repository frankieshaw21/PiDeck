import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessSessionManager } from "./session-manager.js";
import type { PiRuntimeAdapter, PiSessionState } from "../runtime/types.js";

for (const failFirst of [false, true]) {
  test(`concurrent opens share one runtime and ${failFirst ? "retry after failure" : "close safely during startup"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pideck-open-"));
    const state: PiSessionState = { sessionId: "pi", sessionName: "Session", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 };
    let factories = 0, starts = 0, disposed = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = new HarnessSessionManager({ storageDir: root, adapterFactory: () => {
      factories++;
      return {
        harnessSessionId: "test", start: async () => { starts++; await gate; if (failFirst && starts === 1) throw new Error("startup failed"); return state; },
        getState: async () => state, setSessionName: async () => {}, dispose: async () => { disposed++; },
        getMessages: async () => [], getEntries: async () => ({ entries: [], leafId: null }), getContextUsage: async () => null,
        getAvailableModels: async () => [], getCommands: async () => [], setModel: async () => {}, respondToExtensionUi: async () => {},
        subscribe: () => () => {}, abort: async () => {}, prompt: async () => ({ disposition: "started", runId: "run" }),
      } satisfies PiRuntimeAdapter;
    } });
    try {
      await writeFile(join(root, "sessions.json"), JSON.stringify({ version: 1, sessions: [{ id: "test", piSessionId: "pi", projectDir: root, name: "Session", createdAt: "", updatedAt: "" }] }));
      await manager.load();
      const first = manager.open("test"), second = manager.open("test");
      assert.equal(first, second);
      const closing = failFirst ? undefined : manager.close("test");
      release();
      if (failFirst) {
        await assert.rejects(first, /startup failed/);
        assert.equal(disposed, 1);
        await manager.open("test");
        assert.equal(factories, 2);
      } else {
        await first; await closing;
        assert.equal(factories, 1);
        assert.equal(disposed, 1);
        assert.equal(manager.runtime("test"), undefined);
      }
      // Concurrent metadata writes must leave a complete, current index.
      await Promise.all([manager.renameSession("test", "First"), manager.renameSession("test", "Last")]);
      const index = JSON.parse(await readFile(join(root, "sessions.json"), "utf8"));
      assert.equal(index.sessions[0].name, "Last");
    } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
  });
}
