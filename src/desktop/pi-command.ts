import { access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PiCommand { path: string; args: string[]; env?: NodeJS.ProcessEnv }

export async function resolvePiCommand(options: { override?: string; appPath: string; executable: string }): Promise<PiCommand> {
  if (options.override) return { path: options.override, args: [] };
  const entry = join(options.appPath, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
  try {
    await access(entry);
    return { path: options.executable, args: [entry], env: { ELECTRON_RUN_AS_NODE: "1" } };
  } catch {
    if (process.platform !== "win32") {
      const managed = join(homedir(), ".local", "bin", "pi");
      try { await access(managed); return { path: managed, args: [] }; } catch { /* Fall back to PATH. */ }
    }
    return { path: "pi", args: [] };
  }
}
