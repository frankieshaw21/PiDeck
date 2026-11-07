import { readFile, stat } from "node:fs/promises";
import { activeBranch } from "./context-management.js";
import type { HarnessSessionMetadata } from "../core/session-manager.js";
import type { SessionSnapshot } from "./ipc-contract.js";

// A display-only fast path. Pi remains authoritative for context and execution.
// Complex/older histories fall back to the runtime rather than guessing projection rules.
export async function sessionPreview(metadata: HarnessSessionMetadata): Promise<SessionSnapshot | null> {
  if (!metadata.piSessionFile) return null;
  try {
    if ((await stat(metadata.piSessionFile)).size > 16 * 1024 * 1024) return null;
    const records = (await readFile(metadata.piSessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = records.shift();
    if (header?.type !== "session" || header.version !== 3 || header.id !== metadata.piSessionId) return null;
    const entries = records.filter((record) => typeof record.id === "string");
    const branch = activeBranch(entries, entries.at(-1)?.id as string ?? null);
    if (branch.some((entry) => !["message", "model_change", "thinking_level_change", "session_info", "custom", "label"].includes(String(entry.type)))) return null;
    const messages = branch.filter((entry) => entry.type === "message").map((entry) => entry.message);
    return { metadata, preview: true, messages, status: "Idle", state: { sessionId: metadata.piSessionId, isStreaming: false, isCompacting: false, messageCount: messages.length, pendingMessageCount: 0 } };
  } catch { return null; }
}
