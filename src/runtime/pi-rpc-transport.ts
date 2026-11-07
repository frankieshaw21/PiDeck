import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import spawn from "cross-spawn";
import type { ExtensionUiResponse, RpcCommand, RpcRecord, RpcResponse } from "./types.js";

export interface PiRpcTransportOptions {
  piPath?: string;
  executableArgs?: string[];
  cwd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class PiRpcTransport {
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string, {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  readonly #options: PiRpcTransportOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #requestCounter = 0;
  #stderr = "";
  #exitError: Error | undefined;

  constructor(options: PiRpcTransportOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#child) throw new Error("Pi RPC transport is already started");
    const child = spawn(this.#options.piPath ?? "pi", [...(this.#options.executableArgs ?? []), "--mode", "rpc", ...this.#options.args], {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr += chunk;
      this.#events.emit("stderr", chunk);
    });
    child.once("error", (error) => this.#fail(new Error(`Pi process error: ${error.message}`)));
    child.once("exit", (code, signal) => {
      const error = new Error(`Pi exited (code=${String(code)}, signal=${String(signal)}): ${this.#stderr}`);
      this.#exitError = error;
      this.#rejectPending(error);
      this.#events.emit("exit", { code, signal });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { child.off("spawn", onSpawn); reject(error); };
      const onSpawn = () => { child.off("error", onError); resolve(); };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
  }

  onRecord(listener: (record: RpcRecord) => void): () => void {
    this.#events.on("record", listener);
    return () => this.#events.off("record", listener);
  }

  onExit(listener: (value: { code: number | null; signal: NodeJS.Signals | null }) => void): () => void {
    this.#events.on("exit", listener);
    return () => this.#events.off("exit", listener);
  }

  async request(command: Omit<RpcCommand, "id">): Promise<RpcResponse> {
    if (this.#exitError) throw this.#exitError;
    const id = `harness-${++this.#requestCounter}`;
    const timeoutMs = this.#options.requestTimeoutMs ?? 30_000;
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for Pi response to ${command.type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.#write({ ...command, id });
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(id);
      throw error;
    }
    return response;
  }

  async sendExtensionUiResponse(response: ExtensionUiResponse): Promise<void> {
    await this.#write(response);
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timeoutMs = this.#options.shutdownTimeoutMs ?? 2_000;
    const graceful = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
    if (!graceful && child.exitCode === null) {
      await this.#signalTree(child, "SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);
    }
    if (child.exitCode === null) await this.#signalTree(child, "SIGKILL");
  }

  async #signalTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<void> {
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
        killer.once("error", () => resolve());
        killer.once("exit", () => resolve());
      });
      return;
    }
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  }

  async #write(record: object): Promise<void> {
    const child = this.#child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error("Pi stdin is not writable");
    }
    const line = `${JSON.stringify(record)}\n`;
    if (!child.stdin.write(line, "utf8")) {
      await new Promise<void>((resolve, reject) => {
        child.stdin.once("drain", resolve);
        child.stdin.once("error", reject);
      });
    }
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const lf = this.#buffer.indexOf("\n");
      if (lf < 0) return;
      let line = this.#buffer.slice(0, lf);
      this.#buffer = this.#buffer.slice(lf + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      let record: RpcRecord;
      try {
        record = JSON.parse(line) as RpcRecord;
      } catch (error) {
        this.#events.emit("protocolError", new Error(`Invalid Pi JSONL record: ${String(error)}`));
        continue;
      }
      if (record.type === "response" && typeof record.id === "string") {
        const pending = this.#pending.get(record.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.#pending.delete(record.id);
          pending.resolve(record as RpcResponse);
          continue;
        }
      }
      this.#events.emit("record", record);
    }
  }

  #fail(error: Error): void {
    this.#exitError = error;
    this.#rejectPending(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
