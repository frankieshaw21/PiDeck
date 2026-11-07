import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { sessionPreview } from "./session-preview.js";

test("preview follows the active branch and defers complex or invalid histories to Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-preview-"));
  const metadata = { id: "harness", piSessionId: "pi", projectDir: root, name: "Saved", createdAt: "", updatedAt: "", piSessionFile: join(root, "session.jsonl") };
  const header = { type: "session", version: 3, id: "pi" };
  const a = { type: "message", id: "a", parentId: null, message: { role: "user", content: "Hello" } };
  const discarded = { type: "message", id: "discarded", parentId: "a", message: { role: "assistant", content: "Wrong branch" } };
  const b = { type: "message", id: "b", parentId: "a", message: { role: "assistant", content: "Current branch" } };
  const save = (entries: unknown[]) => writeFile(metadata.piSessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  try {
    await save([header, a, discarded, b]);
    assert.deepEqual((await sessionPreview(metadata))?.messages, [a.message, b.message]);
    for (const type of ["compaction", "context_edit", "branch_summary", "custom_message"]) {
      await save([header, a, b, { type, id: "complex", parentId: "b" }]);
      assert.equal(await sessionPreview(metadata), null);
    }
    await save([{ ...header, id: "wrong-session" }, a]);
    assert.equal(await sessionPreview(metadata), null);
    await save([header, { ...b, parentId: "missing" }]);
    assert.equal(await sessionPreview(metadata), null);
    await writeFile(metadata.piSessionFile, '{partial');
    assert.equal(await sessionPreview(metadata), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
