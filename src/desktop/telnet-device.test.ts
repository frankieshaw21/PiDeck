import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { DeviceBroker } from "./devices.js";

test("Telnet authenticates without logging credentials and preserves CLI state", { timeout: 10000 }, async () => {
  const sockets = new Set<Socket>(); const wire: string[] = [];
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
    let phase = 0, pending = "", config = false;
    socket.write(Buffer.from([255, 251, 1])); socket.write("log"); setTimeout(() => socket.write("in: "), 10);
    socket.on("data", (chunk) => {
      // Strip the fixture's single TELNET option response before parsing text.
      const data = Buffer.from(chunk); let offset = 0; if (data[0] === 255 && data.length >= 3) offset = 3;
      pending += data.subarray(offset).toString();
      let index: number;
      while ((index = pending.indexOf("\r\n")) >= 0) {
        const command = pending.slice(0, index); pending = pending.slice(index + 2); wire.push(command);
        if (phase === 0) { phase++; socket.write("Password: "); }
        else if (phase === 1) { phase++; socket.write("admin@DEVICE> "); }
        else { if (command === "configure") config = true; socket.write(`${command}\r\n${command === "observe" ? `mode=${config ? "config" : "normal"}\r\n` : "ok\r\n"}admin@DEVICE${config ? "#" : ">"} `); }
      }
    });
  });
  const broker = new DeviceBroker(() => {}, async () => true);
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string");
    await broker.start(); await broker.connect("telnet", { protocol: "telnet", host: "127.0.0.1", port: address.port, username: "fixture-user", password: "fixture-secret" });
    assert.equal((await broker.run("telnet", "configure", "user")).prompt, "admin@DEVICE#");
    let output = ""; await broker.run("telnet", "observe", "agent", (text) => { output += text; });
    assert.match(output, /mode=config/); assert.deepEqual(wire, ["fixture-user", "fixture-secret", "configure", "observe"]);
    assert.doesNotMatch(JSON.stringify(broker.list()), /fixture-secret/);
  } finally { broker.dispose(); for (const socket of sockets) socket.destroy(); server.close(); }
});
