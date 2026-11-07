// Render streamed text as a readable transcript, without per-packet newlines
// or literal terminal escape/backspace characters.
export function deviceOutput(text: string): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  let result = "";
  for (const char of clean) {
    if (char === "\b") result = result.slice(0, -1);
    else if (char !== "\r" && (char >= " " || char === "\n" || char === "\t")) result += char;
  }
  return result;
}
