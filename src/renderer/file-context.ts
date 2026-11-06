export interface FileContext { name: string; content: string }

const marker = "[Attached text files, JSON]";
export function composeFileContext(message: string, files: FileContext[]): string {
  if (!files.length) return message;
  return `${message}${message ? "\n\n" : ""}${marker}\n${JSON.stringify(files)}\n[/Attached text files]`;
}

export function parseFileContext(message: string): { text: string; files: FileContext[] } {
  const start = message.lastIndexOf(`\n\n${marker}\n`);
  const at = start >= 0 ? start + 2 : message.startsWith(`${marker}\n`) ? 0 : -1;
  if (at < 0 || !message.endsWith("\n[/Attached text files]")) return { text: message, files: [] };
  try {
    const data: unknown = JSON.parse(message.slice(at + marker.length + 1, -"\n[/Attached text files]".length));
    if (!Array.isArray(data) || !data.every((item) => item && typeof item.name === "string" && typeof item.content === "string")) return { text: message, files: [] };
    return { text: at ? message.slice(0, start) : "", files: data };
  } catch { return { text: message, files: [] }; }
}
