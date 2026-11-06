export interface ModelUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

export function modelUsage(message: unknown): ModelUsage | null {
  if (!message || typeof message !== "object") return null;
  const value = message as { role?: unknown; usage?: unknown; stopReason?: unknown };
  if (value.role !== "assistant" || value.stopReason === "error" || value.stopReason === "aborted" || !value.usage || typeof value.usage !== "object") return null;
  const usage = value.usage as Record<string, unknown>;
  const fields = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (!fields.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0) || fields.every((n) => n === 0)) return null;
  return { input: usage.input as number, output: usage.output as number, cacheRead: usage.cacheRead as number, cacheWrite: usage.cacheWrite as number };
}

export function lastModelUsage(messages: unknown[]): ModelUsage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") return modelUsage(message);
  }
  return null;
}
