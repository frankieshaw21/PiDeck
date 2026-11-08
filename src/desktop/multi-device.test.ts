import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { DeviceBroker } from "./devices.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import deviceTools from "../runtime/device-tools.js";

async function fixture(name: string) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); socket.write(`${name}> `); socket.on("data", () => socket.write(`\r\noutput-${name}\r\n${name}> `)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { port: address.port, close: () => { for (const socket of sockets) socket.destroy(); server.close(); } };
}

test("conversation devices are isolated and commands target the selected connection", { timeout: 10000 }, async () => {
  const first = await fixture("first"), second = await fixture("second");
  const broker = new DeviceBroker(() => {}, async () => true);
  try {
    await broker.start();
    const config = { protocol: "telnet" as const, host: "127.0.0.1", username: "admin", password: "", name: "one" };
    await broker.connect("a", { ...config, port: first.port });
    await broker.addSessionDevice("a", { ...config, name: "two", port: second.port });
    const devices = broker.listSessionDevices("a"), target = devices.find((item) => item.alias !== "current");
    assert.ok(target); assert.equal(devices.length, 2); assert.deepEqual(broker.listSessionDevices("other"), []);
    const env = broker.environment("a"), url = new URL(env.HARNESS_DEVICE_URL!); url.pathname = "/devices/exec";
    const invoke = (alias: string, connectionId: string) => fetch(url, { method: "POST", headers: { authorization: `Bearer ${env.HARNESS_DEVICE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ alias, connectionId, command: "observe" }) });
    assert.match(await (await invoke(target.alias, target.connectionId)).text(), /output-second/);
    assert.match(await (await invoke("current", devices[0]!.connectionId)).text(), /output-first/);
    const oldUrl = process.env.HARNESS_DEVICE_URL, oldToken = process.env.HARNESS_DEVICE_TOKEN;
    process.env.HARNESS_DEVICE_URL = env.HARNESS_DEVICE_URL; process.env.HARNESS_DEVICE_TOKEN = env.HARNESS_DEVICE_TOKEN;
    try {
      type Tool = { execute(id: string, params: { alias: string; command: string }): Promise<{ content: Array<{ text: string }> }> };
      const tools = new Map<string, Tool>(); let start: ((event: { systemPrompt: string }) => Promise<unknown>) | undefined;
      deviceTools({ registerTool(value: unknown) { tools.set((value as { name: string }).name, value as Tool); }, on(_name: string, handler: typeof start) { start = handler; } } as unknown as ExtensionAPI);
      assert.ok(start); await start({ systemPrompt: "" });
      const tool = tools.get("device_exec_on"); assert.ok(tool);
      const result = await tool.execute("fixture", { alias: target.alias, command: "observe" });
      assert.match(result.content[0]!.text, /output-second/);
    } finally {
      if (oldUrl === undefined) delete process.env.HARNESS_DEVICE_URL; else process.env.HARNESS_DEVICE_URL = oldUrl;
      if (oldToken === undefined) delete process.env.HARNESS_DEVICE_TOKEN; else process.env.HARNESS_DEVICE_TOKEN = oldToken;
    }
    assert.match(await (await invoke("unknown", target.connectionId)).text(), /not attached/);
    broker.removeSessionDevice("a", target.alias);
    assert.match(await (await invoke(target.alias, target.connectionId)).text(), /not attached/);
  } finally { broker.dispose(); first.close(); second.close(); }
});
