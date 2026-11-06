import { readFile } from "node:fs/promises";
import { join } from "node:path";

type Message = { role: string; content: unknown; timestamp?: number; [key: string]: unknown };
type Entry = { sourceEntry: { id: string }; messages: Message[] };
type Context = { sessionManager: { getSessionId(): string; buildSessionProjection(): { entries: Entry[] } } };
type Pi = { on(name: "context", handler: (event: { messages: Message[] }, ctx: Context) => Promise<{ messages: Message[] } | undefined>): void; registerCommand(name: string, command: { description: string; handler: () => void }): void };
type Edit = { excluded: boolean; text?: string; roundExcluded?: boolean };

export default function contextFilter(pi: Pi): void {
  pi.registerCommand("harness-context-filter-ready", { description: "Harness context filter availability", handler: () => {} });
  pi.on("context", async (event, ctx) => {
    const root = process.env.HARNESS_CONTEXT_DIR;
    if (!root) return;
    let edits: Record<string, Edit>;
    try { edits = JSON.parse(await readFile(join(root, `${ctx.sessionManager.getSessionId()}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const targets = ctx.sessionManager.buildSessionProjection().entries.filter((entry) => edits[entry.sourceEntry.id] && entry.messages.length === 1 && (["user", "assistant"].includes(entry.messages[0]?.role ?? "") || edits[entry.sourceEntry.id]?.roundExcluded));
    if (!targets.length) return;
    const messages = [...event.messages];
    for (const target of targets) {
      const original = target.messages[0]!;
      const matches = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === original.role && message.timestamp === original.timestamp && JSON.stringify(message.content) === JSON.stringify(original.content));
      if (matches.length !== 1) throw new Error("Cannot uniquely identify an edited context message");
      const index = matches[0]!.index;
      const edit = edits[target.sourceEntry.id]!;
      if (edit.excluded || edit.roundExcluded) messages.splice(index, 1);
      else if (typeof edit.text === "string") messages[index] = { ...original, content: [{ type: "text", text: edit.text }] };
    }
    return { messages };
  });
}
