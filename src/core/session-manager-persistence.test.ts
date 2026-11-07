import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessSessionManager } from "./session-manager.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pideck-persistence-"));
  const indexPath = join(root, "sessions.json");
  await writeFile(indexPath, JSON.stringify({ version: 1, sessions: [
    { id: "test", piSessionId: "pi", projectDir: root, name: "Original", createdAt: "", updatedAt: "" },
  ] }));
  const manager = new HarnessSessionManager({ storageDir: root });
  await manager.load();
  return { root, indexPath, manager };
}

test("overlapping metadata saves persist the last update without temporary-file races", async () => {
  const { root, indexPath, manager } = await fixture();
  try {
    await Promise.all(Array.from({ length: 50 }, (_, i) => manager.renameSession("test", `Name ${i}`)));
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    assert.equal(index.sessions[0].name, "Name 49");
    assert.equal(index.sessions.length, 1);
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
    const restored = new HarnessSessionManager({ storageDir: root });
    await restored.load();
    assert.equal(restored.list()[0]?.name, "Name 49");
    await restored.dispose();
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed index replacement cleans its temporary file and subsequent saves recover", async () => {
  const { root, indexPath, manager } = await fixture();
  try {
    // A directory at the destination forces rename to fail on every platform.
    await rm(indexPath);
    await mkdir(indexPath);
    await assert.rejects(manager.renameSession("test", "Failed write"));
    assert.deepEqual((await readdir(root)).filter((name) => name.endsWith(".tmp")), []);
    await rm(indexPath, { recursive: true });
    await manager.renameSession("test", "Recovered");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    assert.equal(index.sessions[0].name, "Recovered");
  } finally {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
