import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ContextEdit { excluded: boolean; text?: string; roundExcluded?: boolean }
export interface ContextItem { id: string; role: "user" | "assistant"; original: string; text: string; excluded: boolean; editable: boolean; roundExcluded: boolean; roundAvailable: boolean; reason?: "compacted" | "attachment" | "complex" }
export type Entry = Record<string, unknown>;

export function activeBranch(entries: Entry[], leafId: string | null): Entry[] {
  const index = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id as string, entry]));
  const branch: Entry[] = []; const seen = new Set<string>(); let id = leafId;
  while (id) { if (seen.has(id)) throw new Error("Invalid session branch"); seen.add(id); const entry = index.get(id); if (!entry) throw new Error("Incomplete session branch"); branch.push(entry); id = typeof entry.parentId === "string" ? entry.parentId : null; }
  return branch.reverse();
}

export function roundEntryIds(branch: Entry[], userId: string, knownIndex?: number): string[] {
  const start = knownIndex ?? branch.findIndex((entry) => entry.id === userId && entry.type === "message" && (entry.message as { role?: unknown })?.role === "user");
  if (start < 0) throw new Error("User message not found");
  const result: string[] = []; const calls = new Set<string>(); const results = new Set<string>();
  for (let i = start; i < branch.length; i++) {
    const entry = branch[i]!;
    if (entry.type === "compaction" || entry.type === "custom_message" || entry.type === "branch_summary") throw new Error("This round cannot be safely excluded");
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (i !== start && message.role === "user") break;
    if (!["user", "assistant", "toolResult", "system"].includes(String(message.role))) throw new Error("Unsupported message in round");
    if (message.role === "system") continue;
    if (typeof entry.id !== "string") throw new Error("Invalid message ID");
    result.push(entry.id);
    if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) if (part?.type === "toolCall" && typeof part.id === "string") calls.add(part.id);
    if (message.role === "toolResult") { if (typeof message.toolCallId !== "string") throw new Error("Invalid tool result"); results.add(message.toolCallId); }
  }
  if (calls.size !== results.size || [...calls].some((id) => !results.has(id))) throw new Error("Tool calls are incomplete in this round");
  return result;
}

export function listContextItems(entries: Entry[], leafId: string | null, edits: Record<string, ContextEdit>): ContextItem[] {
  const branch = activeBranch(entries, leafId);
  const lastCompaction = branch.map((entry) => entry.type).lastIndexOf("compaction");
  return branch.flatMap((entry, index) => {
    if (entry.type !== "message" || typeof entry.id !== "string" || !entry.message || typeof entry.message !== "object") return [];
    const message = entry.message as Record<string, unknown>; if (message.role !== "user" && message.role !== "assistant") return [];
    const role = message.role;
    const content = message.content; const simple = typeof content === "string" || (Array.isArray(content) && content.every((part) => part && part.type === "text" && typeof part.text === "string"));
    const original = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part?.text === "string" ? part.text : "").join("") : "";
    if (role === "assistant" && !original) return [];
    const attachment = role === "user" && (!simple || original.includes("[Attached text files, JSON]"));
    const complex = role === "assistant" && (!simple || !Array.isArray(content) || content.some((part) => part && (part.textSignature !== undefined || part.thinkingSignature !== undefined || part.thoughtSignature !== undefined)));
    const reason = index < lastCompaction ? "compacted" as const : attachment ? "attachment" as const : complex ? "complex" as const : undefined;
    const edit = edits[entry.id];
    let roundAvailable = role === "user" && !reason;
    if (roundAvailable) { try { roundEntryIds(branch, entry.id, index); } catch { roundAvailable = false; } }
    return [{ id: entry.id, role, original, text: edit?.text ?? original, excluded: edit?.excluded ?? false, roundExcluded: edit?.roundExcluded ?? false, roundAvailable, editable: !reason, ...(reason ? { reason } : {}) }];
  });
}

export class ContextStore {
  constructor(private readonly dir: string) {}
  private path(id: string): string { if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Invalid session ID"); return join(this.dir, `${id}.json`); }
  async read(id: string): Promise<Record<string, ContextEdit>> { try { return JSON.parse(await readFile(this.path(id), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; } }
  async write(id: string, entries: Record<string, ContextEdit>): Promise<void> { const path = this.path(id); await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.tmp`; await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 }); await rename(tmp, path); }
  async remove(id: string): Promise<void> { try { await unlink(this.path(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
