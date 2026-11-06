import type { FileContext } from "./file-context.js";
import type { ImageAttachment, RpcRecord } from "../runtime/types.js";

export interface ViewItem { key: string; kind: "user" | "assistant" | "thinking" | "tool" | "notice"; text: string; detail?: string; images?: ImageAttachment[]; files?: FileContext[]; streamIndex?: number; streaming?: boolean; delivery?: "pending" | "failed" | "cancelled"; deliveryError?: string }

function format(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "";
}

export function applyToolEvent(list: ViewItem[], record: RpcRecord, sequence: number): void {
  const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
  const name = String(record.toolName ?? record.name ?? "tool");
  const key = id ? `tool-${id}` : `event-${sequence}`;
  const args = format(record.args);
  const result = format(record.result);
  const detail = [args && `Input:\n${args}`, result && `Output:\n${result}`].filter(Boolean).join("\n\n");
  const index = id ? list.findIndex((item) => item.key === key) : -1;
  const previous = index >= 0 ? list[index] : undefined;
  const input = record.args && typeof record.args === "object" ? record.args as Record<string, unknown> : undefined;
  const target = input?.command ?? input?.path ?? input?.file_path ?? input?.pattern ?? input?.query;
  const action = previous?.text.replace(/^(Running )/, "").replace(/(…| finished| failed)$/, "") ?? `${name}${typeof target === "string" && target ? `: ${target.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
  const item: ViewItem = { key, kind: "tool", text: record.type === "tool_execution_start" ? `Running ${action}…` : record.isError ? `${action} failed` : `${action} finished`, detail: detail || previous?.detail || "" };
  if (previous && result && !args && previous.detail) item.detail = `${previous.detail}\n\nOutput:\n${result}`;
  if (index >= 0) list[index] = item; else list.push(item);
}

export function applyMessageUpdate(list: ViewItem[], record: RpcRecord, sequence: number): void {
  if (record.type !== "message_update" || !record.assistantMessageEvent || typeof record.assistantMessageEvent !== "object") return;
  const update = record.assistantMessageEvent as Record<string, unknown>;
  const type = String(update.type ?? "");
  const kind = type.startsWith("thinking_") ? "thinking" : type.startsWith("text_") ? "assistant" : null;
  if (!kind || !["start", "delta", "end"].some((suffix) => type.endsWith(`_${suffix}`))) return;
  const streamIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
  let index = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]!;
    if (item.kind === kind && item.streaming && item.streamIndex === streamIndex) { index = i; break; }
  }
  if (type.endsWith("_start")) {
    list.push({ key: `stream-${sequence}`, kind, text: "", streamIndex, streaming: true });
    return;
  }
  if (index < 0) {
    if (type.endsWith("_end") && typeof update.content !== "string") return;
    list.push({ key: `stream-${sequence}`, kind, text: "", streamIndex, streaming: true });
    index = list.length - 1;
  }
  const previous = list[index]!;
  const text = type.endsWith("_end") && typeof update.content === "string" ? update.content :
    type.endsWith("_delta") && typeof update.delta === "string" ? previous.text + update.delta : previous.text;
  if (type.endsWith("_end") && !text) list.splice(index, 1);
  else list[index] = { ...previous, text, streaming: !type.endsWith("_end") };
}

export type MessageGroup = { key: string; kind: "turn" | "single"; items: ViewItem[] };
export function groupMessages(items: ViewItem[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const item of items) {
    if (item.kind === "assistant" || item.kind === "thinking" || item.kind === "tool") {
      const last = groups.at(-1);
      if (last?.kind === "turn") last.items.push(item);
      else groups.push({ key: item.key, kind: "turn", items: [item] });
    } else groups.push({ key: item.key, kind: "single", items: [item] });
  }
  return groups;
}

export function groupTimeline(items: ViewItem[]): ViewItem[][] {
  const groups: ViewItem[][] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (item.kind !== "assistant" && last && last[0]?.kind !== "assistant") last.push(item);
    else groups.push([item]);
  }
  return groups;
}
