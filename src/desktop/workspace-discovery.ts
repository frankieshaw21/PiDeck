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
  for (const dir of [...new Set(directories)]) {
    for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
      const path = join(dir, name);
      try { if ((await stat(path)).isFile()) { result.instructions.push({ name, path, scope: dir === agentDir ? "global" : "project" }); break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push({ path, message: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return result;
}
