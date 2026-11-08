import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { skillsRoot } from "./bundled-plugins.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PiRpcAdapter } from "../runtime/pi-rpc-adapter.js";

test("bundled package takes precedence while unrelated user skills remain", { timeout: 30000, skip: !existsSync(join(skillsRoot(), "package.json")) }, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-skill-priority-"));
  const agent = join(root, "agent"), project = join(root, "project");
  await mkdir(join(agent, "skills", "tech-doc-style-chinese"), { recursive: true });
  await mkdir(join(agent, "skills", "other-test-skill"), { recursive: true }); await mkdir(project);
  await writeFile(join(agent, "skills", "tech-doc-style-chinese", "SKILL.md"), "---\nname: tech-doc-style-chinese\ndescription: OLD SHADOWED SKILL\n---\nOld skill.\n");
  await writeFile(join(agent, "skills", "other-test-skill", "SKILL.md"), "---\nname: other-test-skill\ndescription: OTHER PRESERVED SKILL\n---\nOther skill.\n");
  const adapter = new PiRpcAdapter({ harnessSessionId: "priority", piSessionId: "priority", projectDir: project, sessionDir: join(root, "sessions"),
    piPath: process.execPath, piExecutableArgs: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")],
    piEnv: { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1" }, extraArgs: ["--no-mcp", "--extension", skillsRoot()],
  });
  try {
    await adapter.start();
    const commands = await adapter.getCommands();
    const writing = commands.filter((command) => command.name === "skill:tech-doc-style-chinese");
    assert.equal(writing.length, 1);
    assert.doesNotMatch(writing[0]!.description ?? "", /OLD SHADOWED/);
    assert.ok(commands.some((command) => command.name === "skill:other-test-skill"));
    assert.ok(commands.some((command) => command.name === "skill:lark-doc"));
  } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("starting a session in the harness project does not load its Electron entry as an extension", { timeout: 30000, skip: !existsSync(join(skillsRoot(), "package.json")) }, async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-project-session-"));
  const adapter = new PiRpcAdapter({
    harnessSessionId: "project-start", piSessionId: "project-start", projectDir: resolve("."), sessionDir: join(root, "sessions"),
    piPath: process.execPath, piExecutableArgs: [resolve("node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")],
    piEnv: { PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
    extraArgs: ["--no-mcp", "--extension", resolve("dist/runtime/device-tools.js"), "--extension", skillsRoot()],
  });
  try {
    await adapter.start();
    assert.ok((await adapter.getCommands()).some((command) => command.name === "skill:lark-doc"));
  } finally { await adapter.dispose(); await rm(root, { recursive: true, force: true }); }
});
