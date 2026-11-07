// Isolated feasibility fixture. Never loaded by the desktop application.
import { Type, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (!process.env.DEVICE_PROBE_PRODUCTION) pi.registerTool({
    name: "device_exec", label: "Device command", description: "Run a command on the session's connected device.",
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params, signal, onUpdate) {
      const response = await fetch(process.env.DEVICE_PROBE_URL!, {
        method: "POST", signal,
        headers: { authorization: `Bearer ${process.env.DEVICE_PROBE_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ command: params.command }),
      });
      if (!response.ok || !response.body) throw new Error(`Device bridge: ${response.status}`);
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of response.body) {
        text += decoder.decode(chunk, { stream: true });
        onUpdate?.({ content: [{ type: "text", text }], details: {} });
      }
      text += decoder.decode();
      return { content: [{ type: "text", text }], details: {} };
    },
  });
  // Deterministic test model exercises the real agent tool pipeline without
  // accessing a user's model credentials or sending device output externally.
  pi.registerProvider("device-probe", {
    baseUrl: "http://127.0.0.1", apiKey: "local-fixture", api: "openai-completions",
    models: [{ id: "fixture", name: "Local device fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const toolUse = last?.role !== "toolResult";
      const command = JSON.stringify(last).includes("SLOW_PROBE") ? "slow" : "observe";
      const message = {
        role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
        content: toolUse ? [{ type: "toolCall" as const, id: `probe-${Date.now()}`, name: "device_exec", arguments: { command } }] : [{ type: "text" as const, text: "Device observation received." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: toolUse ? "toolUse" as const : "stop" as const, timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (!toolUse) {
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "Device observation received.", partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "Device observation received.", partial: message });
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
