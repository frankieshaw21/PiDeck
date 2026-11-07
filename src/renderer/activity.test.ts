import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyAssistantEnd, applyMessageUpdate, applyToolEvent, type ViewItem } from "./activity.js";

test("indexed history preserves interleaved tool calls, results, and missing starts", () => {
  const indexed: ViewItem[] = [], original: ViewItem[] = [];
  const indexes = new Map<string, number>();
  const records = [
    { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a" } },
    { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b" } },
    { type: "tool_execution_end", toolCallId: "b", result: "B" },
    { type: "tool_execution_end", toolCallId: "a", result: "A", isError: true },
    { type: "tool_execution_end", toolCallId: "missing", result: "No start" },
  ];
  records.forEach((record, i) => {
    for (const list of [indexed, original]) list.push({ key: `text-${i}`, kind: "assistant", text: "Text" });
    applyToolEvent(indexed, record, i, indexes);
    applyToolEvent(original, record, i);
  });
  assert.deepEqual(indexed, original);
});

test("completed assistant text appears even without stream deltas and reports failures", () => {
  const items: ViewItem[] = [{ key: "stream-1", kind: "assistant", text: "previous reply", streamIndex: 0 }];
  applyAssistantEnd(items, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Configured device." }] } }, 4, 3);
  assert.deepEqual(items.map((item) => item.text), ["previous reply", "Configured device."]);
  applyMessageUpdate(items, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" } }, 6);
  applyAssistantEnd(items, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "complete" }] } }, 7, 5);
  assert.equal(items.filter((item) => item.text === "complete").length, 1);
  assert.ok(!items.some((item) => item.text === "partial"));
  applyAssistantEnd(items, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Model unavailable" } }, 9, 8);
  assert.equal(items.at(-1)?.text, "Model unavailable");
});

test("streams tool output into one running activity and replaces it on completion", () => {
  const items: ViewItem[] = [];
  applyToolEvent(items, { type: "tool_execution_start", toolCallId: "device", toolName: "device_exec", args: { command: "uptime" } }, 1);
  applyToolEvent(items, { type: "tool_execution_update", toolCallId: "device", partialResult: "first chunk" }, 2);
  assert.match(items[0]?.text ?? "", /^Running/);
  applyToolEvent(items, { type: "tool_execution_update", toolCallId: "device", partialResult: "complete stream" }, 3);
  assert.match(items[0]?.detail ?? "", /uptime/);
  assert.doesNotMatch(items[0]?.detail ?? "", /first chunk/);
  applyToolEvent(items, { type: "tool_execution_end", toolCallId: "device", toolName: "device_exec", result: "final output" }, 4);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, "device_exec: uptime finished");
  assert.doesNotMatch(items[0]?.detail ?? "", /complete stream/);
  assert.match(items[0]?.detail ?? "", /final output/);
});

test("combines tool start and completion with their input and output", () => {
  const items: ViewItem[] = [];
  applyToolEvent(items, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a.txt" } }, 1);
  applyToolEvent(items, { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [{ type: "text", text: "hello" }] } }, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.text, "read: a.txt finished");
  assert.match(items[0]?.detail ?? "", /a\.txt/);
  assert.match(items[0]?.detail ?? "", /hello/);
});

test("keeps separate calls and identifies failed activity", () => {
  const items: ViewItem[] = [];
  applyToolEvent(items, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a" } }, 1);
  applyToolEvent(items, { type: "tool_execution_start", toolCallId: "b", toolName: "read", args: { path: "b" } }, 2);
  applyToolEvent(items, { type: "tool_execution_end", toolCallId: "a", toolName: "read", isError: true, result: "error" }, 3);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.text, "read: a failed");
  assert.match(items[1]?.detail ?? "", /"b"/);
});

test("groups assistant text and tool activity by user turn", async () => {
  const { groupMessages } = await import("./activity.js");
  const groups = groupMessages([
    { key: "u1", kind: "user", text: "one" },
    { key: "a1", kind: "assistant", text: "before" },
    { key: "t1", kind: "tool", text: "read" },
    { key: "a2", kind: "assistant", text: "after" },
    { key: "u2", kind: "user", text: "two" },
    { key: "t2", kind: "tool", text: "write" },
  ]);
  assert.deepEqual(groups.map((group) => group.items.map((item) => item.key)), [["u1"], ["a1", "t1", "a2"], ["u2"], ["t2"]]);
});

test("streams visible thinking and preserves chronological activity", async () => {
  const { applyMessageUpdate, groupTimeline } = await import("./activity.js");
  const items: ViewItem[] = [];
  const update = (type: string, fields: Record<string, unknown> = {}) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...fields } });
  applyMessageUpdate(items, update("thinking_start"), 1);
  applyMessageUpdate(items, update("thinking_delta", { delta: "Checking" }), 2);
  assert.equal(items[0]?.text, "Checking");
  applyMessageUpdate(items, update("thinking_end", { content: "Checking files" }), 3);
  applyToolEvent(items, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "a" } }, 4);
  applyMessageUpdate(items, update("text_start"), 5);
  applyMessageUpdate(items, update("text_delta", { delta: "Done" }), 6);
  applyMessageUpdate(items, update("text_end", { content: "Done." }), 7);
  assert.deepEqual(items.map((item) => [item.kind, item.text]), [["thinking", "Checking files"], ["tool", "Running read: a…"], ["assistant", "Done."]]);
  assert.deepEqual(groupTimeline(items).map((group) => group.map((item) => item.kind)), [["thinking", "tool"], ["assistant"]]);
});

test("does not display empty or redacted thinking", async () => {
  const { applyMessageUpdate } = await import("./activity.js");
  const items: ViewItem[] = [];
  applyMessageUpdate(items, { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }, 1);
  applyMessageUpdate(items, { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "" } }, 2);
  assert.equal(items.length, 0);
});
