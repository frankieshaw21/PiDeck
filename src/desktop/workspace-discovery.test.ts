import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverWorkspace } from "./workspace-discovery.js";

test("discovers configuration names without exposing credentials and reports malformed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-discovery-"));
  try {
    const agent = join(root, "agent");
    const project = join(root, "project");
    await mkdir(agent); await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { example: { headers: { Authorization: "secret-value" } } } }));
    await writeFile(join(project, ".pi", "mcp.json"), "{");
    await writeFile(join(project, "AGENTS.md"), "instructions");
    const result = await discoverWorkspace(project, agent);
    assert.deepEqual(result.connections.map((item) => item.name), ["example"]);
    assert.equal(result.instructions.some((item) => item.path === join(project, "AGENTS.md")), true);
    assert.equal(result.warnings.length, 1);
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discovers project and global connections and instruction precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-"));
  try {
    const agent = join(root, "agent");
    const project = join(root, "parent", "project");
    await mkdir(agent, { recursive: true });
    await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { globalServer: {} } }));
    await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { projectServer: {} } }));
    await writeFile(join(agent, "AGENTS.md"), "global");
    await writeFile(join(root, "parent", "AGENTS.md"), "parent");
    await writeFile(join(project, "AGENTS.md"), "fallback");
    await writeFile(join(project, "AGENTS.override.md"), "override");
    const result = await discoverWorkspace(project, agent);
    assert.deepEqual(result.connections.map(({ name, scope }) => ({ name, scope })), [
      { name: "globalServer", scope: "global" }, { name: "projectServer", scope: "project" },
    ]);
    assert.ok(result.instructions.some((item) => item.path === join(agent, "AGENTS.md") && item.scope === "global"));
    assert.ok(result.instructions.some((item) => item.path === join(root, "parent", "AGENTS.md")));
    assert.ok(result.instructions.some((item) => item.path === join(project, "AGENTS.override.md")));
    assert.ok(!result.instructions.some((item) => item.path === join(project, "AGENTS.md")));
    assert.deepEqual(result.warnings, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("handles absent files and invalid connection schemas", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-workspace-empty-"));
  try {
    const agent = join(root, "agent");
    const project = join(root, "project");
    await mkdir(agent); await mkdir(join(project, ".pi"), { recursive: true });
    await writeFile(join(project, ".pi", "mcp.json"), JSON.stringify({ mcpServers: [] }));
    const result = await discoverWorkspace(project, agent);
    assert.deepEqual(result.connections, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.path, join(project, ".pi", "mcp.json"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
