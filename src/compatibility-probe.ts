import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiRpcAdapter } from "./runtime/pi-rpc-adapter.js";
import type { RpcRecord, RuntimeEvent } from "./runtime/types.js";

const root = await mkdtemp(join(tmpdir(), "minimal-pi-compat-"));
const extensionPath = resolve("fixtures/extensions/compatibility.ts");
const skillPath = join(root, "skills", "harness-probe", "SKILL.md");
await mkdir(join(root, "skills", "harness-probe"), { recursive: true });
await writeFile(skillPath, "---\nname: harness-probe\ndescription: Minimal skill used to verify Pi skill discovery in Minimal Pi Harness.\n---\n\n# Harness Probe\n\nWhen explicitly invoked, reply with `HARNESS_SKILL_OK` and do not use tools.\n");
const adapter = new PiRpcAdapter({
  harnessSessionId: "compatibility-probe",
  piSessionId: "compatibility-probe",
  projectDir: process.cwd(),
  sessionDir: join(root, "sessions"),
  piPath: process.env.PI_PATH ?? "pi",
  extraArgs: ["--extension", extensionPath, "--skill", skillPath, "--tools", "read", "--no-mcp"],
});

const records: RpcRecord[] = [];
const uiMethods: string[] = [];
let resolveSettled: (() => void) | undefined;
let cancelNextInput = false;
const unsubscribe = adapter.subscribe((event: RuntimeEvent) => {
  records.push(event.record);
  if (event.record.type === "agent_settled") resolveSettled?.();
  if (event.record.type !== "extension_ui_request") return;
  const method = String(event.record.method);
  uiMethods.push(method);
  const id = String(event.record.id);
  if (method === "confirm") void adapter.respondToExtensionUi({ type: "extension_ui_response", id, confirmed: true });
  if (method === "select") void adapter.respondToExtensionUi({ type: "extension_ui_response", id, value: "Alpha" });
  if (method === "input" && cancelNextInput) {
    cancelNextInput = false;
    void adapter.respondToExtensionUi({ type: "extension_ui_response", id, cancelled: true });
  } else if (method === "input") {
    void adapter.respondToExtensionUi({ type: "extension_ui_response", id, value: "probe-value" });
  }
  if (method === "editor") void adapter.respondToExtensionUi({ type: "extension_ui_response", id, value: "Edited line 1\nEdited line 2" });
});

function waitForSettled(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for agent_settled")), 120_000);
    resolveSettled = () => { clearTimeout(timer); resolveSettled = undefined; resolvePromise(); };
  });
}

try {
  const state = await adapter.start();
  assert.ok(state.model && state.model.provider !== "unknown");
  const models = await adapter.getAvailableModels();
  assert.ok(models.some((model) => model.provider === state.model?.provider && model.id === state.model.id));
  await adapter.setModel(state.model.provider, state.model.id);

  const commands = await adapter.getCommands();
  assert.ok(commands.some((command) => command.source === "extension" && command.name === "harness-ui"));
  assert.ok(commands.some((command) => command.source === "skill" && command.name.includes("harness-probe")));

  const uiResult = await adapter.prompt("/harness-ui");
  assert.equal(uiResult.disposition, "handled");
  for (const method of ["confirm", "select", "input", "editor", "notify", "setStatus"]) {
    assert.ok(uiMethods.includes(method), `Missing Extension UI method: ${method}`);
  }

  cancelNextInput = true;
  const cancelResult = await adapter.prompt("/harness-ui-cancel");
  assert.equal(cancelResult.disposition, "handled");
  assert.ok(records.some((record) => record.type === "extension_ui_request" && record.method === "notify" && record.message === "Cancellation received"));

  records.length = 0;
  const skillSettled = waitForSettled();
  const skillResult = await adapter.prompt("/skill:harness-probe");
  assert.equal(skillResult.disposition, "started");
  await skillSettled;
  assert.match(JSON.stringify(await adapter.getMessages()), /HARNESS_SKILL_OK/);

  records.length = 0;
  const settled = waitForSettled();
  const toolResult = await adapter.prompt("You must use the read tool to read package.json, then reply with only the package name.");
  assert.equal(toolResult.disposition, "started");
  await settled;
  assert.ok(records.some((record) => record.type === "tool_execution_start" && record.toolName === "read"));
  const messages = JSON.stringify(await adapter.getMessages());
  assert.match(messages, /minimal-pi-desktop-harness/);

  console.log(JSON.stringify({
    model: `${state.model.provider}/${state.model.id}`,
    modelSwitch: true,
    extensionCommand: true,
    extensionUiCancellation: true,
    skillDiscoveredAndInvoked: true,
    builtinReadTool: true,
    extensionUi: [...new Set(uiMethods)],
  }, null, 2));
} finally {
  unsubscribe();
  await adapter.dispose();
  await rm(root, { recursive: true, force: true });
}
