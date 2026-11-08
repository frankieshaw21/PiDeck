import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import ssh2, { type Connection } from "ssh2";
const { Server } = ssh2;
import { DeviceBroker, cliPrompt, type DeviceState } from "./devices.js";
import { PiRpcAdapter } from "../runtime/pi-rpc-adapter.js";
import type { RpcRecord } from "../runtime/types.js";

const shellPath = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
test("recognizes operational and configuration prompts but not echoed commands", () => {
  assert.equal(cliPrompt("\x1b[Jadmin@DEVICE> "), "admin@DEVICE>");
  assert.equal(cliPrompt("[edit]\r\nadmin@DEVICE# "), "admin@DEVICE#");
  assert.equal(cliPrompt("admin@DEVICE(config)# "), "admin@DEVICE(config)#");
  assert.equal(cliPrompt("$ "), "$");
  assert.equal(cliPrompt("admin@DEVICE> configure"), undefined);
});

test("DEVICE CLI sends exact commands, preserves config mode and lets Pi reply", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-device-test-"));
  const connections = new Set<Connection>();
  const wire: string[] = [];
  const states: DeviceState[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = new Server({ hostKeys: [generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }) as Buffer] }, (connection) => {
    connections.add(connection); connection.on("error", () => {}); connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (ctx) => ctx.accept());
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept(); session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => {
        const channel = acceptShell(); let configMode = false;
        channel.write("\x1b[Jadmin@DEVICE> ");
        channel.on("data", (chunk: Buffer) => {
          const value = chunk.toString(); wire.push(value);
          const command = value.replace(/\r$/, "");
          // Echo in separate packets, reproducing the reported device behavior.
          [...command].forEach((char, index) => timers.add(setTimeout(() => channel.write(char), index * 3)));
          timers.add(setTimeout(() => {
            channel.write("\r\n");
            if (command === "configure") { configMode = true; channel.write("Entering configuration mode\r\n[edit]\r\n"); }
            else if (command === "observe") channel.write(`mode=${configMode ? "configuration" : "operational"}\r\n`);
            else channel.write("unknown command.\r\n");
            channel.write(configMode ? "admin@DEVICE# " : "admin@DEVICE> ");
          }, command.length * 3 + 30));
        });
      });
    }));
  });
  const broker = new DeviceBroker((state) => states.push(state), async () => true);
  let adapter: PiRpcAdapter | undefined;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await broker.start();
    await broker.connect("device", { host: "127.0.0.1", port: address.port, username: "admin", password: "test", name: "核心交换机" });
    const result = await broker.run("device", "configure", "user");
    assert.deepEqual(result, { prompt: "admin@DEVICE#" });
    assert.deepEqual(wire, ["configure\r"]);
    assert.ok(states.at(-1)!.logs.some((log) => log.kind === "output" && log.text.includes("configure\r\nEntering")));
    assert.ok(states.at(-1)!.logs.length < 10, "One character must not produce a new log row");
    await assert.rejects(broker.run("device", "configure\nshow version", "user"), /one command/);
    const env = broker.environment("device");
    const statusUrl = new URL(env.HARNESS_DEVICE_URL!); statusUrl.pathname = "/status";
    assert.equal((await fetch(statusUrl)).status, 403);
    const status = await (await fetch(statusUrl, { headers: { authorization: `Bearer ${env.HARNESS_DEVICE_TOKEN}` } })).json() as { name: string; host: string; status: string; connectionId: string };
    assert.equal(status.name, "核心交换机"); assert.equal(status.status, "connected");
    assert.ok(!JSON.stringify(status).includes("test"));
    const stale = await fetch(env.HARNESS_DEVICE_URL!, { method: "POST", headers: { authorization: `Bearer ${env.HARNESS_DEVICE_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ connectionId: "old", command: "danger" }) });
    assert.match(await stale.text(), /connection changed/);
    assert.deepEqual(wire, ["configure\r"], "A stale device token must not send a command");
    adapter = new PiRpcAdapter({ harnessSessionId: "device", piSessionId: randomUUID(), projectDir: process.cwd(), sessionDir: join(root, "sessions"),
      piPath: process.execPath, piExecutableArgs: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")],
      piEnv: { ...env, PI_CODING_AGENT_DIR: join(root, "agent"), DEVICE_PROBE_PRODUCTION: "1" },
      extraArgs: ["--no-mcp", "--no-skills", "--no-prompt-templates", "--extension", resolve("fixtures/extensions/device-feasibility.ts"), "--extension", resolve("dist/runtime/device-tools.js"), "--provider", "device-probe", "--model", "fixture", "--tools", "device_exec"],
    });
    const events: RpcRecord[] = [];
    adapter.subscribe(({ record }) => events.push(record));
    await adapter.start();
    const settled = new Promise<void>((resolveSettled, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("Agent never replied")); }, 10000);
      const unsubscribe = adapter!.subscribe(({ record }) => { if (record.type === "agent_settled") { clearTimeout(timeout); unsubscribe(); resolveSettled(); } });
    });
    await adapter.prompt("Observe the device after configure"); await settled;
    assert.deepEqual(wire, ["configure\r", "observe\r"]);
    assert.ok(events.some((r) => r.type === "tool_execution_end" && !r.isError));
    // Exercise the same rendering reducer as the actual conversation: tool
    // completion must be followed by a visible assistant response.
    const { applyMessageUpdate, applyToolEvent } = await import("../renderer/activity.js");
    const visible: import("../renderer/activity.js").ViewItem[] = [];
    events.forEach((record, sequence) => { applyMessageUpdate(visible, record, sequence); if (String(record.type).startsWith("tool_execution_")) applyToolEvent(visible, record, sequence); });
    assert.ok(visible.some((item) => item.kind === "assistant" && item.text.includes("Device observation received")));
    const messages = JSON.stringify(await adapter.getMessages());
    assert.match(messages, /mode=configuration/);
    broker.rename("device", "新名称");
    assert.equal((await (await fetch(statusUrl, { headers: { authorization: `Bearer ${env.HARNESS_DEVICE_TOKEN}` } })).json() as { name: string }).name, "新名称");
    assert.doesNotMatch(messages, /Exit code: 0/);
    const errorResult = await broker.run("device", "invalid-command", "user");
    assert.equal(errorResult.exitCode, undefined, "A CLI prompt is not a successful exit status");
  } finally {
    await adapter?.dispose(); broker.dispose();
    for (const timer of timers) clearTimeout(timer);
    for (const connection of connections) connection.end();
    server.close(); await rm(root, { recursive: true, force: true });
  }
});
test("production SSH broker and Pi tool share a real persistent shell and stream output", { skip: !existsSync(shellPath), timeout: 40000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-ssh-test-"));
  const connections = new Set<Connection>();
  let shells = 0;
  const shellProcesses = new Set<ReturnType<typeof spawn>>();
  const server = new Server({ hostKeys: [generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }) as Buffer] }, (connection) => {
    connections.add(connection); connection.on("close", () => connections.delete(connection)); connection.on("error", () => {});
    connection.on("authentication", (ctx) => ctx.method === "password" && ctx.password === "test-only-password" ? ctx.accept() : ctx.reject());
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept(); session.on("pty", (acceptPty) => acceptPty?.());
      session.on("shell", (acceptShell) => {
        const channel = acceptShell(); shells++;
        const child = spawn(shellPath, ["--noprofile", "--norc", "-i"], { stdio: "pipe", env: { ...process.env, BASH_ENV: "", PS1: "test@host:~$ ", TERM: "dumb" } });
        shellProcesses.add(child);
        child.once("exit", () => shellProcesses.delete(child));
        channel.on("data", (chunk: Buffer) => child.stdin.write(chunk.toString().replace(/\r/g, "\n"))); child.stdout.pipe(channel); child.stderr.pipe(channel, { end: false });
        child.stdin.on("error", () => {}); child.on("error", () => channel.close());
        child.on("close", () => channel.close()); channel.on("close", () => child.kill());
      });
    }));
  });
  const states: DeviceState[] = [];
  const broker = new DeviceBroker((state) => states.push(state), async () => true);
  let adapter: PiRpcAdapter | undefined;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); assert.ok(address && typeof address !== "string");
    await broker.start();
    const config = { host: "127.0.0.1", port: address.port, username: "test", password: "test-only-password" };
    await broker.connect("a", config); await broker.connect("b", config);
    await broker.run("a", "export DEVICE_TEST_STATE=shared-manual-state", "user");
    let other = ""; await broker.run("b", "printf '%s\\n' \"${DEVICE_TEST_STATE-unset}\"", "user", (text) => other += text);
    assert.match(other, /unset/);
    assert.equal((await broker.run("a", "false", "user")).exitCode, undefined);
    const env = broker.environment("a");
    assert.equal((await fetch(env.HARNESS_DEVICE_URL!, { method: "POST" })).status, 403);
    const events: RpcRecord[] = [];
    function eventWhere(predicate: (record: RpcRecord) => boolean) {
      return new Promise<RpcRecord>((resolveEvent, reject) => {
        const timer = setTimeout(() => { unsubscribe(); reject(new Error("Pi event timeout")); }, 15000);
        const unsubscribe = adapter!.subscribe(({ record }) => { if (predicate(record)) { clearTimeout(timer); unsubscribe(); resolveEvent(record); } });
      });
    }
    // The deterministic model requests 'observe'; a POSIX function supplies a
    // genuine shell command with two output chunks and the manual shell state.
    await broker.run("a", "observe() { printf '%s\\n' \"$DEVICE_TEST_STATE\"; sleep 0.3; printf 'second chunk\\n'; }; slow() { printf 'waiting\\n'; sleep 5; }", "user");
    adapter = new PiRpcAdapter({ harnessSessionId: "a", piSessionId: randomUUID(), projectDir: process.cwd(), sessionDir: join(root, "sessions"),
      piPath: process.execPath, piExecutableArgs: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")],
      piEnv: { ...env, PI_CODING_AGENT_DIR: join(root, "agent"), DEVICE_PROBE_PRODUCTION: "1" },
      extraArgs: ["--no-mcp", "--no-skills", "--no-prompt-templates", "--extension", resolve("fixtures/extensions/device-feasibility.ts"), "--extension", resolve("dist/runtime/device-tools.js"), "--provider", "device-probe", "--model", "fixture", "--tools", "device_exec"],
    });
    adapter.subscribe(({ record }) => events.push(record));
    await adapter.start();
    const settled = eventWhere((record) => record.type === "agent_settled");
    const update = eventWhere((record) => record.type === "tool_execution_update");
    await adapter.prompt("Observe device"); await update;
    await assert.rejects(broker.run("a", "echo overlap", "user"), /busy/);
    await settled;
    assert.match(JSON.stringify(await adapter.getMessages()), /shared-manual-state/);
    assert.ok(events.filter((record) => record.type === "tool_execution_update").length >= 2);
    assert.ok(events.some((record) => record.type === "tool_execution_end" && !record.isError));
    assert.equal(shells, 2, "Agent and manual commands must reuse the same shell");
    assert.ok(!JSON.stringify(events).includes(config.password));
    assert.ok(states.some((state) => state.logs.some((log) => log.source === "agent" && log.text.includes("shared-manual-state"))));
    const waiting = eventWhere((record) => record.type === "tool_execution_update" && JSON.stringify(record).includes("waiting"));
    const stopped = eventWhere((record) => record.type === "agent_settled");
    await adapter.prompt("SLOW_PROBE"); await waiting; await adapter.abort(); await stopped;
    for (let i = 0; i < 50 && broker.list().find((state) => state.sessionId === "a")?.busy; i++) await new Promise((done) => setTimeout(done, 20));
    assert.equal(broker.list().find((state) => state.sessionId === "a")?.status, "disconnected");
    await assert.rejects(broker.run("a", "echo stale", "agent"), /Connect/);
    await broker.connect("a", config);
    assert.equal((await broker.run("a", "true", "user")).exitCode, undefined);
    broker.remove("a");
    assert.equal((await fetch(env.HARNESS_DEVICE_URL!, { method: "POST", headers: { authorization: `Bearer ${env.HARNESS_DEVICE_TOKEN}` } })).status, 403);
    const denied = new DeviceBroker(() => {}, async () => false);
    try { await assert.rejects(denied.connect("denied", config), /SSH/); } finally { denied.dispose(); }
  } finally {
    await adapter?.dispose(); broker.dispose();
    for (const child of shellProcesses) child.kill("SIGKILL");
    for (const connection of connections) connection.end();
    server.close(); await rm(root, { recursive: true, force: true });
  }
});
