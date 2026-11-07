import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { resolvePiCommand } from "./pi-command.js";
import { PiRpcAdapter } from "../runtime/pi-rpc-adapter.js";

test("explicit Pi overrides the bundled runtime, which is selected when present", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-command-"));
  try {
    const dir = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle");
    await mkdir(dir, { recursive: true });
    const entry = join(dir, "cli.js");
    await writeFile(entry, "");
    assert.deepEqual(await resolvePiCommand({ override: "custom-pi", appPath: root, executable: "electron" }), { path: "custom-pi", args: [] });
    assert.deepEqual(await resolvePiCommand({ appPath: root, executable: "electron" }), { path: "electron", args: [entry], env: { ELECTRON_RUN_AS_NODE: "1" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("bundled Pi starts an RPC session with Electron's runtime", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "bundled-pi-test-"));
  const executable = process.platform === "win32" ? resolve("node_modules/electron/dist/electron.exe") : process.platform === "darwin" ? resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron") : resolve("node_modules/electron/dist/electron");
  const command = await resolvePiCommand({ appPath: process.cwd(), executable });
  const adapter = new PiRpcAdapter({ harnessSessionId: "bundled-test", piSessionId: "bundled-test", projectDir: root, sessionDir: join(root, "sessions"), piPath: command.path, piExecutableArgs: command.args, piEnv: { ...command.env, PI_CODING_AGENT_DIR: join(root, "agent") } });
  try {
    assert.ok(command.env?.ELECTRON_RUN_AS_NODE);
    assert.ok(await adapter.start());
  } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});
