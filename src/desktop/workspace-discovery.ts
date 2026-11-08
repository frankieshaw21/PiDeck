import { loadSkills } from "@earendil-works/pi-coding-agent";
import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { WorkspaceDiscovery } from "./ipc-contract.js";

/** Check the actual application PATH without launching or installing a program. */
export async function executableAvailable(name: string, pathValue = process.env.PATH ?? ""): Promise<boolean> {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const candidate = join(dir, name + extension);
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(candidate)).isFile()) return true;
      } catch { /* Continue searching PATH. */ }
    }
  }
  return false;
}

export async function discoverWorkspace(project: string, agentDir: string, bundledSkillPaths: string[] = []): Promise<WorkspaceDiscovery> {
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
  if (bundledSkillPaths.length) {
    if (!(await Promise.all(bundledSkillPaths.map(async (path) => { try { return (await stat(path)).isFile(); } catch { return false; } }))).every(Boolean)) result.warnings.push({ path: "HARNESS_SKILLS_DIR", message: "独立 skill 目录缺失或不完整；请配置 HARNESS_SKILLS_DIR。 / External skill resources are missing or incomplete." });
    // Detect same-name default skills. Bundled skills load via the CLI package,
    // which has precedence; report the conflict without changing user files.
    const discovered = loadSkills({ cwd: project, agentDir, skillPaths: bundledSkillPaths, includeDefaults: true });
    for (const diagnostic of discovered.diagnostics) {
      const collision = diagnostic.collision;
      if (diagnostic.type === "collision" && collision?.resourceType === "skill" && bundledSkillPaths.includes(collision.loserPath)) {
        result.warnings.push({ path: collision.loserPath, message: `Skill 名称冲突 / Skill name collision: ${collision.name}. Harness loads the bundled plugin first; the other skill is ${collision.winnerPath}.` });
      }
    }
  }
  return result;
}
