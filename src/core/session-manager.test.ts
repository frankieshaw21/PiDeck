import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessSessionManager } from "./session-manager.js";

const piPath = process.env.PI_PATH ?? "pi";

test("creates independent Pi sessions and restores the Harness index", async () => {
  const root = await mkdtemp(join(tmpdir(), "minimal-pi-test-"));
  const storageDir = join(root, "state");
  const firstManager = new HarnessSessionManager({ storageDir, piPath });
  try {
    await firstManager.load();
    const a = await firstManager.create(process.cwd(), "A");
    const b = await firstManager.create(process.cwd(), "B");
    assert.notEqual(a.metadata.id, b.metadata.id);
    assert.notEqual(a.state.sessionId, b.state.sessionId);
    assert.equal(a.state.isStreaming, false);
    assert.equal(b.state.isStreaming, false);
    assert.equal(a.state.sessionName, "A");
    assert.ok(a.state.sessionFile);
    await firstManager.renameSession(a.metadata.id, "Renamed A");
    await firstManager.dispose();

    const restoredManager = new HarnessSessionManager({ storageDir, piPath });
    try {
      await restoredManager.load();
      assert.equal(restoredManager.list().length, 2);
      assert.equal(restoredManager.list().find((item) => item.id === a.metadata.id)?.name, "Renamed A");
      const restored = await restoredManager.open(a.metadata.id);
      assert.equal(restored.state.sessionId, a.state.sessionId);
      assert.equal(restored.state.sessionName, "Renamed A");
      assert.equal(restored.state.messageCount, 0);
      assert.equal(restoredManager.list().find((item) => item.id === a.metadata.id)?.piSessionFile, restored.state.sessionFile);
      await restoredManager.deleteSession(b.metadata.id);
      assert.equal(restoredManager.list().length, 1);
    } finally {
      await restoredManager.dispose();
    }
  } finally {
    await firstManager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
