import { randomUUID } from "node:crypto";
import spawn from "cross-spawn";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

export interface ManagedExtension { path: string; name: string; enabled: boolean; entries: string[]; managedRoot?: string }

function installPackage(piPath: string, source: string, agentDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(piPath, ["install", source], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "0" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); };
    child.stdout?.on("data", append); child.stderr?.on("data", append);
    const timer = setTimeout(() => { child.kill(); reject(new Error("Extension installation timed out")); }, 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error(`Extension installation failed: ${output.trim() || `exit ${code}`}`)); });
  });
}

export function networkPackagePath(source: string): string {
  if (source.startsWith("npm:")) {
    const match = /^npm:((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)(?:@([a-zA-Z0-9._~+^*-]+))?$/.exec(source);
    if (!match || !match[1] || match[1].split("/").some((part) => part === "." || part === ".." || part === "@." || part === "@..")) throw new Error("Invalid npm package source");
    return join("npm", "node_modules", match[1]);
  }
  if ((!source.startsWith("git:") && !source.startsWith("https://")) || source.includes("%")) throw new Error("Invalid network source");
  const raw = source.startsWith("git:") ? source.slice(4) : source;
  const url = raw.startsWith("https://") ? new URL(raw) : new URL(`https://${raw}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error("Invalid HTTPS Git repository source");
  const path = url.pathname.replace(/^\/+/, "").split("@")[0]!.replace(/\.git$/, "").replace(/\/$/, "");
  if (path.split("/").length < 2 || path.split("/").some((part) => !part || part === "." || part === ".." || !/^[a-z0-9._~-]+$/i.test(part))) throw new Error("Invalid Git repository path");
  return join("git", url.hostname, path);
}

export class ExtensionStore {
  private entries: ManagedExtension[] = [];
  private writes = Promise.resolve();
  constructor(private readonly indexPath: string) {}
  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (!Array.isArray(data) || data.some((e) => !e || typeof e.path !== "string" || (e.managedRoot === undefined && !isAbsolute(e.path)) || (e.managedRoot !== undefined && (typeof e.managedRoot !== "string" || !isAbsolute(e.managedRoot))) || typeof e.name !== "string" || typeof e.enabled !== "boolean" || !Array.isArray(e.entries) || e.entries.some((p: unknown) => typeof p !== "string" || !isAbsolute(p)))) throw new Error("Invalid extension index");
      this.entries = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  list(): ManagedExtension[] { return this.entries.map((e) => ({ ...e, entries: [...e.entries] })); }
  enabledPaths(): string[] { return this.entries.filter((e) => e.enabled).flatMap((e) => e.entries); }
  async add(source: string): Promise<void> {
    const path = await realpath(source);
    if (this.entries.some((e) => e.path === path)) throw new Error("Extension already added");
    const info = await stat(path);
    let entries: string[] = [];
    if (info.isFile() && [".ts", ".js", ".mjs", ".mts"].includes(extname(path).toLowerCase())) entries = [path];
    else if (info.isDirectory()) {
      try {
        const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
        if (Array.isArray(manifest.pi?.extensions)) {
          for (const entry of manifest.pi.extensions) {
            if (typeof entry !== "string" || isAbsolute(entry)) throw new Error("Invalid extension entry");
            const resolved = await realpath(resolve(path, entry));
            if (relative(path, resolved).startsWith("..") || !(await stat(resolved)).isFile()) throw new Error("Extension entry must be a file inside its directory");
            entries.push(resolved);
          }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!entries.length) {
        for (const name of ["index.ts", "index.js", "index.mjs", "index.mts"]) {
          try { const candidate = await realpath(join(path, name)); if (relative(path, candidate).startsWith("..")) throw new Error("Extension entry must be a file inside its directory"); if ((await stat(candidate)).isFile()) { entries = [candidate]; break; } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
      }
    }
    if (!entries.length) throw new Error("Choose a JavaScript/TypeScript extension file or a directory containing an index file or pi.extensions manifest");
    this.entries.push({ path, name: basename(path), enabled: true, entries });
    await this.save();
  }
  async addNetwork(source: string, piPath: string): Promise<void> {
    source = source.trim();
    if (source.length > 512 || /\s/.test(source)) throw new Error("Invalid network source");
    const packagePath = networkPackagePath(source);
    if (this.entries.some((entry) => entry.path === source)) throw new Error("Extension already added");
    const requestedRoot = join(dirname(this.indexPath), "extension-packages", randomUUID());
    await mkdir(requestedRoot, { recursive: true });
    const managedRoot = await realpath(requestedRoot);
    try {
      await installPackage(piPath, source, managedRoot);
      const entry = await realpath(join(managedRoot, packagePath));
      if (!(await stat(entry)).isDirectory() || relative(managedRoot, entry).startsWith("..")) throw new Error("Installed package was not found");
      this.entries.push({ path: source, name: basename(entry), enabled: true, entries: [entry], managedRoot });
      await this.save();
    } catch (error) {
      this.entries = this.entries.filter((entry) => entry.managedRoot !== managedRoot);
      await rm(managedRoot, { recursive: true, force: true });
      throw error;
    }
  }
  async setEnabled(path: string, enabled: boolean): Promise<void> {
    const entry = this.entries.find((e) => e.path === path); if (!entry) throw new Error("Extension not found");
    entry.enabled = enabled; await this.save();
  }
  async remove(path: string): Promise<void> {
    if (!this.entries.some((e) => e.path === path)) throw new Error("Extension not found");
    const removed = this.entries.find((e) => e.path === path)!;
    this.entries = this.entries.filter((e) => e.path !== path); await this.save();
    if (removed.managedRoot) {
      const root = await realpath(join(dirname(this.indexPath), "extension-packages"));
      const rel = relative(root, removed.managedRoot);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("/") && !rel.includes("\\")) await rm(removed.managedRoot, { recursive: true, force: true });
    }
  }
  private async save(): Promise<void> {
    const content = JSON.stringify(this.entries, null, 2);
    this.writes = this.writes.catch(() => {}).then(async () => { await mkdir(dirname(this.indexPath), { recursive: true }); const temp = `${this.indexPath}.tmp`; await writeFile(temp, content, { mode: 0o600 }); await rename(temp, this.indexPath); });
    await this.writes;
  }
}
