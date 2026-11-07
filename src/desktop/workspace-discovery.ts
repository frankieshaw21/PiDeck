import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkspaceDiscovery } from "./ipc-contract.js";

export async function discoverWorkspace(project: string, agentDir: string): Promise<WorkspaceDiscovery> {
  const result: WorkspaceDiscovery = { connections: [], instructions: [], warnings: [] };
  for (const [scope, path] of [["global", join(agentDir, "mcp.json")], ["project", join(project, ".pi", "mcp.json")]] as const) {
    try {
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Expected an object");
      const servers = (data as Record<string, unknown>).mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Expected mcpServers object");
      for (const name of Object.keys(servers)) result.connections.push({ name, scope, path });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push({ path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const directories = [agentDir];
  for (let dir = project; ; dir = dirname(dir)) { directories.push(dir); if (dirname(dir) === dir) break; }
  // Check directories concurrently, preserving both scope order and filename precedence.
  const discoveries = await Promise.all([...new Set(directories)].map(async (dir) => {
    const instructions: WorkspaceDiscovery["instructions"] = [];
    const warnings: WorkspaceDiscovery["warnings"] = [];
    const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
    const checks = await Promise.all(names.map(async (name) => {
      const path = join(dir, name);
      try { return { name, path, file: (await stat(path)).isFile() }; }
      catch (error) { return { name, path, error: error as NodeJS.ErrnoException }; }
    }));
    for (const check of checks) {
      if (check.file) { instructions.push({ name: check.name, path: check.path, scope: dir === agentDir ? "global" : "project" }); break; }
      if (check.error && check.error.code !== "ENOENT") warnings.push({ path: check.path, message: check.error.message });
    }
    return { instructions, warnings };
  }));
  for (const discovery of discoveries) {
    result.instructions.push(...discovery.instructions);
    result.warnings.push(...discovery.warnings);
  }
  return result;
}
