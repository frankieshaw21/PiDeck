import { join } from "node:path";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  ContextUsage,
  ExtensionUiResponse,
  ImageAttachment,
  PiRuntimeAdapter,
  PiSessionState,
  PromptDisposition,
  RpcRecord,
  RpcResponse,
  RuntimeEvent,
  ThinkingLevel,
} from "./types.js";
import { PiRpcTransport } from "./pi-rpc-transport.js";

export interface PiRpcAdapterOptions {
  harnessSessionId: string;
  piSessionId: string;
  piSessionFile?: string;
  projectDir: string;
  sessionDir: string;
  piPath?: string;
  piExecutableArgs?: string[];
  piEnv?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  contextDir?: string;
}

export class PiRpcAdapter implements PiRuntimeAdapter {
  readonly harnessSessionId: string;
  readonly #transport: PiRpcTransport;
  readonly #sessionArgs: string[];
  readonly #sessionFile: string | undefined;
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  #sequence = 0;
  #activeRunId: string | undefined;
  #unsubscribe: (() => void) | undefined;
  #unsubscribeExit: (() => void) | undefined;

  constructor(options: PiRpcAdapterOptions) {
    this.harnessSessionId = options.harnessSessionId;
    this.#sessionFile = options.piSessionFile;
    const args = [
      "--session-id", options.piSessionId,
      "--session-dir", options.sessionDir,
      "--offline",
      ...(options.contextDir ? ["--extension", join(import.meta.dirname, "context-filter.js")] : []),
      ...(options.extraArgs ?? []),
    ];
    this.#sessionArgs = args;
    this.#transport = new PiRpcTransport({
      ...(options.piPath ? { piPath: options.piPath } : {}),
      ...(options.piExecutableArgs ? { executableArgs: options.piExecutableArgs } : {}),
      cwd: options.projectDir,
      env: { ...options.piEnv, ...(options.contextDir ? { HARNESS_CONTEXT_DIR: options.contextDir } : {}) },
      args,
    });
  }

  async start(): Promise<PiSessionState> {
    this.#unsubscribe = this.#transport.onRecord((record) => this.#emit(record));
    this.#unsubscribeExit = this.#transport.onExit(({ code, signal }) => {
      this.#emit({ type: "runtime_process_exit", code, signal });
      this.#activeRunId = undefined;
    });
    try {
      if (this.#sessionFile) {
        try {
          await access(this.#sessionFile);
          // A known path avoids scanning every session header on each cold open.
          this.#sessionArgs.splice(0, 2, "--session", this.#sessionFile);
        } catch (error) {
          // Older indexes and moved files still use Pi's ID-based discovery.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await this.#transport.start();
      return this.getState();
    } catch (error) {
      this.#unsubscribe();
      this.#unsubscribe = undefined;
      this.#unsubscribeExit();
      this.#unsubscribeExit = undefined;
      throw error;
    }
  }

  async prompt(message: string, images?: ImageAttachment[]): Promise<{ disposition: PromptDisposition; runId: string }> {
    if (this.#activeRunId) throw new Error("This session already has an active run");
    const runId = randomUUID();
    this.#activeRunId = runId;
    try {
      const response = await this.#checked(this.#transport.request({ type: "prompt", message, ...(images?.length ? { images } : {}) }));
      const data = response.data as { disposition: PromptDisposition };
      if (data.disposition === "handled") this.#activeRunId = undefined;
      return { disposition: data.disposition, runId };
    } catch (error) {
      this.#activeRunId = undefined;
      throw error;
    }
  }

  async abort(): Promise<void> {
    await this.#checked(this.#transport.request({ type: "abort" }));
  }

  async getState(): Promise<PiSessionState> {
    const response = await this.#checked(this.#transport.request({ type: "get_state" }));
    return response.data as PiSessionState;
  }

  async getMessages(): Promise<unknown[]> {
    const response = await this.#checked(this.#transport.request({ type: "get_messages" }));
    return (response.data as { messages: unknown[] }).messages;
  }

  async getEntries(): Promise<{ entries: Record<string, unknown>[]; leafId: string | null }> {
    const response = await this.#checked(this.#transport.request({ type: "get_entries" }));
    return response.data as { entries: Record<string, unknown>[]; leafId: string | null };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const response = await this.#checked(this.#transport.request({ type: "get_session_stats" }));
    const usage = (response.data as { contextUsage?: ContextUsage } | undefined)?.contextUsage;
    if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 ||
      (usage.tokens !== null && (!Number.isFinite(usage.tokens) || usage.tokens < 0)) ||
      (usage.percent !== null && (!Number.isFinite(usage.percent) || usage.percent < 0))) return null;
    return usage;
  }

  async setSessionName(name: string): Promise<void> {
    await this.#checked(this.#transport.request({ type: "set_session_name", name }));
  }

  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string }>> {
    const response = await this.#checked(this.#transport.request({ type: "get_available_models" }));
    return (response.data as { models: Array<{ provider: string; id: string; name?: string }> }).models;
  }

  async getCommands(): Promise<Array<{ name: string; source: "extension" | "prompt" | "skill"; description?: string }>> {
    const response = await this.#checked(this.#transport.request({ type: "get_commands" }));
    return (response.data as { commands: Array<{ name: string; source: "extension" | "prompt" | "skill"; description?: string }> }).commands;
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const response = await this.#checked(this.#transport.request({ type: "set_model", provider, modelId }));
    return response.data;
  }

  async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
    const response = await this.#checked(this.#transport.request({ type: "get_available_thinking_levels" }));
    return (response.data as { levels: ThinkingLevel[] }).levels;
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    await this.#checked(this.#transport.request({ type: "set_thinking_level", level }));
  }

  respondToExtensionUi(response: ExtensionUiResponse): Promise<void> {
    return this.#transport.sendExtensionUiResponse(response);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeExit?.();
    this.#unsubscribeExit = undefined;
    this.#listeners.clear();
    await this.#transport.stop();
  }

  #emit(record: RpcRecord): void {
    const event: RuntimeEvent = {
      harnessSessionId: this.harnessSessionId,
      ...(this.#activeRunId ? { runId: this.#activeRunId } : {}),
      sequence: ++this.#sequence,
      record,
    };
    for (const listener of this.#listeners) listener(event);
    if (record.type === "agent_settled") this.#activeRunId = undefined;
  }

  async #checked(promise: Promise<RpcResponse>): Promise<RpcResponse> {
    const response = await promise;
    if (!response.success) throw new Error(response.error ?? `Pi command ${response.command} failed`);
    return response;
  }
}
