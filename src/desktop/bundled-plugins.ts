import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Skills are installed independently of the application and may be replaced by the user. */
export function skillsRoot(): string {
  return process.env.HARNESS_SKILLS_DIR ? resolve(process.env.HARNESS_SKILLS_DIR) : join(homedir(), ".pi", "harness-skills");
}

/** Read explicitly declared skill paths without coupling the app to their contents. */
export function externalSkillPaths(root = skillsRoot()): string[] {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { pi?: { skills?: unknown } };
    if (!Array.isArray(manifest.pi?.skills)) return [];
    return manifest.pi.skills.flatMap((entry: unknown) => {
      if (typeof entry !== "string" || isAbsolute(entry)) return [];
      const path = resolve(root, entry), rel = relative(root, path);
      return rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel) ? [path] : [];
    });
  } catch { return []; }
}
