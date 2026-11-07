import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PiRpcAdapter, type PiRpcAdapterOptions } from "../runtime/pi-rpc-adapter.js";
import type { PiRuntimeAdapter, PiSessionState } from "../runtime/types.js";

export interface HarnessSessionMetadata {
  id: string;
  piSessionId: string;
  projectDir: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  piSessionFile?: string;
}

interface HarnessIndex { version: 1; sessions: HarnessSessionMetadata[] }

export interface SessionManagerOptions {
  storageDir: string;
  piPath?: string;
  piExecutableArgs?: string[];
  piEnv?: NodeJS.ProcessEnv;
  extensionPaths?: () => string[];
  adapterFactory?: (options: PiRpcAdapterOptions) => PiRuntimeAdapter;
}

export class HarnessSessionManager {
  readonly #storageDir: string;
  readonly #indexPath: string;
  readonly #piSessionDir: string;
  readonly #piPath: string | undefined;
  readonly #piExecutableArgs: string[] | undefined;
  readonly #piEnv: NodeJS.ProcessEnv | undefined;
  readonly #extensionPaths: () => string[];
  readonly #adapterFactory: (options: PiRpcAdapterOptions) => PiRuntimeAdapter;
  readonly #sessions = new Map<string, HarnessSessionMetadata>();
  readonly #opening = new Map<string, Promise<{ metadata: HarnessSessionMetadata; state: PiSessionState }>>();
  #writes = Promise.resolve();
  readonly #runtimes = new Map<string, PiRuntimeAdapter>();

  constructor(options: SessionManagerOptions) {
    this.#storageDir = options.storageDir;
    this.#indexPath = join(options.storageDir, "sessions.json");
    this.#piSessionDir = join(options.storageDir, "pi-sessions");
    this.#piPath = options.piPath;
    this.#piExecutableArgs = options.piExecutableArgs;
    this.#piEnv = options.piEnv;
    this.#extensionPaths = options.extensionPaths ?? (() => []);
    this.#adapterFactory = options.adapterFactory ?? ((adapterOptions) => new PiRpcAdapter(adapterOptions));
  }

  async load(): Promise<void> {
    await mkdir(this.#piSessionDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.#indexPath, "utf8")) as HarnessIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) throw new Error("Unsupported Harness index");
      this.#sessions.clear();
      for (const session of parsed.sessions) this.#sessions.set(session.id, session);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  list(): HarnessSessionMetadata[] {
    return [...this.#sessions.values()].map((item) => ({ ...item }));
  }

  runtime(id: string): PiRuntimeAdapter | undefined {
    return this.#runtimes.get(id);
  }

  async create(projectDir: string, name = "New session"): Promise<{ metadata: HarnessSessionMetadata; state: PiSessionState }> {
    const now = new Date().toISOString();
    const metadata: HarnessSessionMetadata = {
      id: randomUUID(),
      piSessionId: randomUUID(),
      projectDir,
      name,
      createdAt: now,
      updatedAt: now,
    };
    const runtime = this.#makeRuntime(metadata);
    await runtime.start();
    await runtime.setSessionName(name);
    const state = await runtime.getState();
    const stored: HarnessSessionMetadata = {
      ...metadata,
      ...(state.sessionFile ? { piSessionFile: state.sessionFile } : {}),
    };
    this.#sessions.set(stored.id, stored);
    this.#runtimes.set(stored.id, runtime);
    await this.#save();
    return { metadata: { ...stored }, state };
  }

  open(id: string): Promise<{ metadata: HarnessSessionMetadata; state: PiSessionState }> {
    const pending = this.#opening.get(id);
    if (pending) return pending;
    const opening = this.#open(id).finally(() => this.#opening.delete(id));
    this.#opening.set(id, opening);
    return opening;
  }

  async #open(id: string): Promise<{ metadata: HarnessSessionMetadata; state: PiSessionState }> {
    const metadata = this.#sessions.get(id);
    if (!metadata) throw new Error(`Unknown Harness session: ${id}`);
    const existing = this.#runtimes.get(id);
    if (existing) return { metadata: { ...metadata }, state: await existing.getState() };
    const runtime = this.#makeRuntime(metadata);
    try {
      let state = await runtime.start();
      if (state.sessionName !== metadata.name) {
        await runtime.setSessionName(metadata.name);
        state = await runtime.getState();
      }
      if (state.sessionFile && state.sessionFile !== metadata.piSessionFile) {
        const updated = { ...metadata, piSessionFile: state.sessionFile, updatedAt: new Date().toISOString() };
        this.#sessions.set(id, updated);
        await this.#save();
      }
      this.#runtimes.set(id, runtime);
      return { metadata: { ...(this.#sessions.get(id) ?? metadata) }, state };
    } catch (error) {
      await runtime.dispose().catch(() => {});
      throw error;
    }
  }

  async renameSession(id: string, name: string): Promise<void> {
    const metadata = this.#sessions.get(id);
    if (!metadata) throw new Error(`Unknown Harness session: ${id}`);
    this.#sessions.set(id, { ...metadata, name, updatedAt: new Date().toISOString() });
    await this.#runtimes.get(id)?.setSessionName(name);
    await this.#save();
  }

  async close(id: string): Promise<void> {
    await this.#opening.get(id)?.catch(() => {});
    const runtime = this.#runtimes.get(id);
    this.#runtimes.delete(id);
    await runtime?.dispose();
  }

  async deleteSession(id: string): Promise<void> {
    const metadata = this.#sessions.get(id);
    if (!metadata) throw new Error(`Unknown Harness session: ${id}`);
    await this.close(id);
    if (metadata.piSessionFile) {
      try {
        await unlink(metadata.piSessionFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#sessions.delete(id);
    await this.#save();
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.#opening.values());
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()));
  }

  #makeRuntime(metadata: HarnessSessionMetadata): PiRuntimeAdapter {
    return this.#adapterFactory({
      harnessSessionId: metadata.id,
      piSessionId: metadata.piSessionId,
      projectDir: metadata.projectDir,
      sessionDir: this.#piSessionDir,
      contextDir: join(this.#storageDir, "context-edits"),
      extraArgs: this.#extensionPaths().flatMap((path) => ["--extension", path]),
      ...(this.#piPath ? { piPath: this.#piPath } : {}),
      ...(this.#piExecutableArgs ? { piExecutableArgs: this.#piExecutableArgs } : {}),
      ...(this.#piEnv ? { piEnv: this.#piEnv } : {}),
    });
  }

  async #save(): Promise<void> {
    const index: HarnessIndex = { version: 1, sessions: this.list() };
    const content = `${JSON.stringify(index, null, 2)}\n`;
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.#indexPath), { recursive: true });
      // Each write owns its temporary file, even across manager instances.
      const temp = `${this.#indexPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temp, this.#indexPath);
      } finally {
        // Best-effort cleanup must not hide the original persistence error.
        await unlink(temp).catch(() => {});
      }
    });
    await this.#writes;
  }
}
