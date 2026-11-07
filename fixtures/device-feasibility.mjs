// Real SSH over loopback + real Pi RPC + deterministic model. No physical device.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { PiRpcAdapter } from "../dist/runtime/pi-rpc-adapter.js";

const require = createRequire(join(process.env.DEVICE_PROBE_DEPS ?? join(tmpdir(), "pideck-ssh-feasibility-deps"), "package.json"));
const { Server, Client, utils } = require("ssh2");
const root = await mkdtemp(join(tmpdir(), "pideck-device-probe-"));
const password = randomUUID();
const token = randomUUID();
const audit = [];
const connections = new Set();
const clients = [];
let adapter;
let streamCount = 0;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const hostKey = utils.parseKey(privateKey).getPublicSSH();
const sshServer = new Server({ hostKeys: [privateKey] }, (connection) => {
  connection.on("error", () => {}); // Peer shutdown can race fixture cleanup on Windows.
  connections.add(connection);
  connection.on("close", () => connections.delete(connection));
  connection.on("authentication", (ctx) => ctx.method === "password" && ctx.username === "fixture" && ctx.password === password ? ctx.accept() : ctx.reject());
  connection.on("ready", () => connection.on("session", (accept) => {
    const session = accept();
    session.on("pty", (acceptPty) => acceptPty());
    session.on("shell", (acceptShell) => {
      const shell = acceptShell();
      streamCount++;
      let state = "initial";
      let pending = "";
      const timers = new Set();
      shell.on("close", () => { for (const timer of timers) clearTimeout(timer); });
      shell.on("data", (data) => {
        pending += data.toString();
        while (pending.includes("\n")) {
          const index = pending.indexOf("\n");
          const command = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
          if (command.startsWith("set ")) { state = command.slice(4); shell.write(`state=${state}\n__DONE__\n`); }
          else if (command === "observe") {
            shell.write(`device=${state}\n`);
            timers.add(setTimeout(() => shell.write("cpu=7%\n__DONE__\n"), 120));
          } else if (command === "slow") {
            shell.write("waiting\n");
            timers.add(setTimeout(() => shell.write("late\n__DONE__\n"), 5000));
          } else shell.write("unknown command\n__DONE__\n");
        }
      });
    });
  }));
});

async function connectDevice() {
  const client = new Client(); clients.push(client);
  client.on("error", () => {}); // once(ready) below still rejects connection errors.
  const ready = once(client, "ready");
  client.connect({ host: "127.0.0.1", port: sshServer.address().port, username: "fixture", password,
    hostVerifier: (key) => key.equals(hostKey), readyTimeout: 5000 });
  await ready;
  const shell = await new Promise((resolveShell, reject) => client.shell((error, channel) => error ? reject(error) : resolveShell(channel)));
  let busy = false;
  return {
    get busy() { return busy; },
    async run(command, source, onData = () => {}, signal) {
      if (busy) throw new Error("Device busy");
      if (signal?.aborted) throw new Error("Cancelled");
      busy = true;
      audit.push({ source, direction: "input", command });
      try {
        return await new Promise((resolveRun, reject) => {
          let text = "";
          const cleanup = () => { clearTimeout(timer); shell.off("data", data); shell.off("close", closed); signal?.removeEventListener("abort", aborted); };
          const fail = (error) => { cleanup(); reject(error); };
          const closed = () => fail(new Error("Device disconnected"));
          const aborted = () => { fail(new Error("Cancelled")); shell.close(); };
          const timer = setTimeout(() => { fail(new Error("Device timeout")); shell.close(); }, 8000);
          const data = (chunk) => {
            const value = chunk.toString(); text += value;
            audit.push({ source, direction: "output", text: value }); onData(value);
            if (text.includes("__DONE__\n")) { cleanup(); resolveRun(text); }
          };
          shell.on("data", data); shell.once("close", closed); signal?.addEventListener("abort", aborted, { once: true });
          shell.write(`${command}\n`);
        });
      } finally { busy = false; }
    },
  };
}

const bridge = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
  if (req.method !== "POST" || req.url !== "/session-a/exec") { res.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of req) body += chunk;
  const { command } = JSON.parse(body);
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    res.writeHead(200, { "content-type": "text/plain" });
    await device.run(command, "agent", (chunk) => res.write(chunk), controller.signal);
    res.end();
  } catch { res.destroy(); }
});
let device;
const records = [];
const waiters = [];
function waitFor(predicate) {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => reject(new Error("Probe event timeout")), 15000);
    waiters.push((record) => { if (predicate(record)) { clearTimeout(timer); resolveWait(record); } });
  });
}
try {
  // Obtain the fixture's public key for strict pinning; never accept arbitrary hosts.
  sshServer.listen(0, "127.0.0.1"); await once(sshServer, "listening");
  device = await connectDevice();
  const otherDevice = await connectDevice();
  await device.run("set manual-state", "user");
  assert.match(await otherDevice.run("observe", "user"), /device=initial/);
  bridge.listen(0, "127.0.0.1"); await once(bridge, "listening");
  const url = `http://127.0.0.1:${bridge.address().port}/session-a/exec`;
  assert.equal((await fetch(url, { method: "POST" })).status, 403);
  adapter = new PiRpcAdapter({ harnessSessionId: "session-a", piSessionId: randomUUID(), projectDir: process.cwd(), sessionDir: join(root, "sessions"),
    piPath: process.execPath, piExecutableArgs: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")],
    piEnv: { PI_CODING_AGENT_DIR: join(root, "agent"), DEVICE_PROBE_URL: url, DEVICE_PROBE_TOKEN: token },
    extraArgs: ["--no-mcp", "--no-skills", "--no-prompt-templates", "--extension", resolve("fixtures/extensions/device-feasibility.ts"), "--provider", "device-probe", "--model", "fixture", "--tools", "device_exec"],
  });
  adapter.subscribe(({ record }) => { records.push(record); for (const waiter of waiters) waiter(record); });
  await adapter.start();
  assert.ok((await adapter.getState()).model?.provider === "device-probe");
  const settled = waitFor((r) => r.type === "agent_settled");
  const partial = waitFor((r) => r.type === "tool_execution_update");
  await adapter.prompt("Observe the connected device.");
  await partial;
  await assert.rejects(device.run("observe", "user"), /busy/);
  await settled;
  assert.ok(records.some((r) => r.type === "tool_execution_start" && r.toolName === "device_exec"));
  assert.ok(records.filter((r) => r.type === "tool_execution_update").length >= 2);
  assert.ok(records.some((r) => r.type === "tool_execution_end" && !r.isError));
  assert.match(JSON.stringify(await adapter.getMessages()), /device=manual-state/);
  assert.equal(streamCount, 2, "Manual and agent must reuse session A shell");
  assert.ok(!JSON.stringify(records).includes(password));
  assert.ok(audit.some((r) => r.source === "agent" && r.direction === "output"));
  const slowPartial = waitFor((r) => r.type === "tool_execution_update" && JSON.stringify(r).includes("waiting"));
  const aborted = waitFor((r) => r.type === "agent_settled");
  await adapter.prompt("SLOW_PROBE"); await slowPartial; await adapter.abort(); await aborted;
  for (let n = 0; n < 50 && device.busy; n++) await new Promise((done) => setTimeout(done, 20));
  assert.equal(device.busy, false, "Abort must release the broker's device lease");
  console.log(JSON.stringify({ realSshLoopback: true, pinnedHostKey: true, realPiRpc: true, model: "deterministic local fixture (no external AI request)", sharedPersistentShell: true, perSessionIsolation: true, liveToolUpdates: true, manualAgentContentionRejected: true, abortReleasesDevice: true, unauthenticatedBridgeRejected: true, credentialsAbsentFromRpc: true, physicalDeviceTested: false }, null, 2));
} finally {
  await adapter?.dispose();
  bridge.closeAllConnections(); bridge.close();
  for (const client of clients) client.destroy();
  for (const connection of connections) connection.end();
  sshServer.close();
  await rm(root, { recursive: true, force: true });
}
