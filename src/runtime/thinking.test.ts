import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PiRpcAdapter } from "./pi-rpc-adapter.js";
import { THINKING_LEVELS } from "./types.js";

test("native Pi reports supported thinking levels and applies them to session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-thinking-"));
  const adapter = new PiRpcAdapter({
    harnessSessionId: "thinking", piSessionId: "thinking", projectDir: root, sessionDir: root,
    piPath: process.execPath,
    piExecutableArgs: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")],
    piEnv: { PI_CODING_AGENT_DIR: join(root, "agent") },
  });
  try {
    await adapter.start();
    const levels = await adapter.getAvailableThinkingLevels();
    assert.ok(levels.length > 0);
    assert.ok(levels.every((level) => THINKING_LEVELS.includes(level)));
    for (const level of levels) {
      await adapter.setThinkingLevel(level);
      assert.equal((await adapter.getState()).thinkingLevel, level);
    }
  } finally {
    await adapter.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
