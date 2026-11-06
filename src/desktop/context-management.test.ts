import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listContextItems } from "./context-management.js";

test("shows current user messages and conservatively marks compacted and attachment content", () => {
  const entries = [
    { id: "a", parentId: null, type: "message", message: { role: "user", content: "old" } },
    { id: "b", parentId: "a", type: "compaction" },
    { id: "c", parentId: "b", type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    { id: "d", parentId: "c", type: "message", message: { role: "user", content: [{ type: "image", data: "x" }] } },
    { id: "other", parentId: "a", type: "message", message: { role: "user", content: "abandoned" } },
  ];
  const result = listContextItems(entries, "d", { c: { excluded: false, text: "revised" } });
  assert.deepEqual(result.map((item) => [item.id, item.editable, item.reason, item.text]), [["a", false, "compacted", "old"], ["c", true, undefined, "revised"], ["d", false, "attachment", ""]]);
});

test("groups a user turn with its assistant calls and tool results", async () => {
  const { activeBranch, roundEntryIds } = await import("./context-management.js");
  const entries = [
    { id: "u", parentId: null, type: "message", message: { role: "user", content: "question" } },
    { id: "a", parentId: "u", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1" }] } },
    { id: "t", parentId: "a", type: "message", message: { role: "toolResult", toolCallId: "call-1", content: [] } },
    { id: "b", parentId: "t", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { id: "v", parentId: "b", type: "message", message: { role: "user", content: "next" } },
  ];
  const branch = activeBranch(entries, "v");
  assert.deepEqual(roundEntryIds(branch, "u"), ["u", "a", "t", "b"]);
  assert.throws(() => roundEntryIds(branch.filter((entry) => entry.id !== "t"), "u"), /incomplete/);
});

test("offers plain assistant text for editing and blocks complex or signed responses", () => {
  const entries = [
    { id: "u", parentId: null, type: "message", message: { role: "user", content: "question" } },
    { id: "plain", parentId: "u", type: "message", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { id: "signed", parentId: "plain", type: "message", message: { role: "assistant", content: [{ type: "text", text: "signed", textSignature: "sig" }] } },
    { id: "complex", parentId: "signed", type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "reason" }, { type: "text", text: "result" }] } },
  ];
  const items = listContextItems(entries, "complex", { plain: { excluded: false, text: "edited" } });
  assert.deepEqual(items.map((item) => [item.id, item.role, item.editable, item.reason]), [["u", "user", true, undefined], ["plain", "assistant", true, undefined], ["signed", "assistant", false, "complex"], ["complex", "assistant", false, "complex"]]);
  assert.equal(items[1]?.text, "edited");
});
