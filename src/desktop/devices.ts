import ssh2, { type ClientChannel } from "ssh2";
const { Client } = ssh2;
type Client = InstanceType<typeof Client>;
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { Socket } from "node:net";
import { TelnetProtocol } from "./telnet-protocol.js";

export interface DeviceConfig { protocol?: "ssh" | "telnet"; host: string; port: number; username: string; password: string; name?: string }
export interface DeviceLog { source: "user" | "agent" | "system"; kind?: "input" | "output" | "notice"; text: string; time: string }
export interface DeviceState { sessionId: string; connectionId: string; name: string; host: string; port: number; username: string; protocol?: "ssh" | "telnet"; prompt?: string; status: "connecting" | "connected" | "disconnected"; busy: boolean; logs: DeviceLog[] }
interface Connection { state: DeviceState; client: Client | Socket; tail: string; source?: "user" | "agent"; shell?: ClientChannel | Socket; pending?: { data(text: string): void; fail(error: Error): void } }

// CLI prompts may arrive one byte at a time with ANSI redraws. Only inspect
// the final visible line; output before that line cannot complete a command.
export function cliPrompt(text: string): string | undefined {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  let line = "";
  for (const char of clean) {
    if (char === "\n" || char === "\r") line = "";
    else if (char === "\b") line = line.slice(0, -1);
    else line += char;
  }
  return /^(?:[\w.@:/~()[\] -]{1,160}[>#$]|[$#]) ?$/.test(line) ? line.trimEnd() : undefined;
}
// Conservative detection: stop instead of automatically answering an interactive pager.
export function cliPager(text: string): boolean {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  return /(?:--\s*more\s*--|<---\s*more\s*--->|\[more\])\s*$/i.test(clean);
}
export function cliConfirmation(text: string): boolean {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  const finalLine = clean.split("\n").at(-1) ?? "";
  return /(?:\[\s*(?:y\/n|yes\/no)\s*\]|\(\s*(?:y\/n|yes\/no)\s*\))\s*[:?]?\s*$/i.test(finalLine);
}
function promptIdentity(prompt: string) {
  const identity = prompt.replace(/\([^)]*\)/g, "").replace(/[>#$]$/, "").trim();
  return identity.includes("@") && identity.includes(":") ? identity.slice(0, identity.indexOf(":")) : identity;
}

export class DeviceBroker {
  private connections = new Map<string, Connection>();
  private tokens = new Map<string, string>();
  private additional = new Map<string, Map<string, DeviceBroker>>();
  private pendingAdditional = new Map<string, DeviceBroker>();
  private server: Server | undefined;
  private url = "";
  constructor(private publish: (state: DeviceState) => void, private trust: (host: string, fingerprint: string) => Promise<boolean>) {}
  async start() {
    this.server = createServer(async (req, res) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const id = token ? this.tokens.get(token) : undefined;
      if (!id) { res.writeHead(403).end(); return; }
      if (req.method === "GET" && req.url === "/devices") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.listSessionDevices(id)));
        return;
      }
      if (req.method === "GET" && req.url === "/status") {
        const connection = this.connections.get(id);
        const state = connection?.state;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state ? { connectionId: state.connectionId, name: state.name, host: state.host, port: state.port, username: state.username, protocol: state.protocol ?? "ssh", status: state.status, prompt: state.prompt } : { status: "disconnected" }));
        return;
      }
      if (req.method !== "POST" || !["/exec", "/devices/exec"].includes(req.url ?? "")) { res.writeHead(404).end(); return; }
      const abort = new AbortController();
      res.on("close", () => { if (!res.writableEnded) abort.abort(); });
      try {
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 40000) throw new Error("Command too large"); }
        const { command, connectionId, alias } = JSON.parse(raw);
        if (req.url === "/devices/exec" && typeof alias !== "string") throw new Error("A device alias is required");
        const target = req.url === "/devices/exec" && typeof alias === "string" && alias !== "current" ? this.additional.get(id)?.get(alias) : this;
        if (!target) throw new Error("Device is not attached to this conversation");
        if (typeof connectionId !== "string" || target.connections.get(id)?.state.connectionId !== connectionId) throw new Error("Device connection changed; inspect the current device before issuing commands");
        const onData = (text: string) => {
          if (!res.headersSent) res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(JSON.stringify({ text }) + "\n");
        };
        const result = await target.run(id, command, "agent", onData, abort.signal);
        res.end(JSON.stringify({ done: true, ...result }) + "\n");
      } catch (error) {
        if (!res.headersSent) res.writeHead(400, { "content-type": "application/x-ndjson" });
        res.end(JSON.stringify({ error: String(error) }) + "\n");
      }
    });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(0, "127.0.0.1", resolve); });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Device bridge failed");
    this.url = `http://127.0.0.1:${address.port}/exec`;
  }
  environment(sessionId: string): NodeJS.ProcessEnv {
    for (const [token, id] of this.tokens) if (id === sessionId) this.tokens.delete(token);
    const token = randomUUID(); this.tokens.set(token, sessionId);
    return { HARNESS_DEVICE_URL: this.url, HARNESS_DEVICE_TOKEN: token };
  }
  list(): DeviceState[] { return [...this.connections.values()].map(({ state }) => ({ ...state, logs: [...state.logs] })); }
  listSessionDevices(sessionId: string): Array<{ alias: string; connectionId: string; name: string; host: string; port: number; username: string; protocol: "ssh" | "telnet"; status: DeviceState["status"]; prompt?: string }> {
    const items: Array<{ alias: string; connectionId: string; name: string; host: string; port: number; username: string; protocol: "ssh" | "telnet"; status: DeviceState["status"]; prompt?: string }> = [];
    const append = (alias: string, broker: DeviceBroker) => { const state = broker.connections.get(sessionId)?.state; if (state) items.push({ alias, connectionId: state.connectionId, name: state.name, host: state.host, port: state.port, username: state.username, protocol: state.protocol ?? "ssh", status: state.status, ...(state.prompt ? { prompt: state.prompt } : {}) }); };
    append("current", this);
    for (const [alias, broker] of this.additional.get(sessionId) ?? []) append(alias, broker);
    return items;
  }
  async addSessionDevice(sessionId: string, input: DeviceConfig): Promise<void> {
    if (this.pendingAdditional.has(sessionId)) throw new Error("Another device is connecting");
    const slots = this.additional.get(sessionId) ?? new Map<string, DeviceBroker>();
    if (slots.size >= 7) throw new Error("A conversation supports at most eight devices");
    const existing = this.listSessionDevices(sessionId);
    if (existing.some((item) => item.status !== "disconnected" && item.host === input.host && item.port === input.port && item.protocol === (input.protocol ?? "ssh"))) throw new Error("Device endpoint already connected in this conversation");
    const child = new DeviceBroker(() => {}, this.trust), alias = randomUUID();
    this.pendingAdditional.set(sessionId, child);
    try {
      await child.connect(sessionId, input);
      if (this.pendingAdditional.get(sessionId) !== child) throw new Error("Device connection was cancelled");
      slots.set(alias, child); this.additional.set(sessionId, slots);
    } catch (error) { child.dispose(); throw error; }
    finally { if (this.pendingAdditional.get(sessionId) === child) this.pendingAdditional.delete(sessionId); }
  }
  removeSessionDevice(sessionId: string, alias: string): void {
    const slots = this.additional.get(sessionId), child = slots?.get(alias);
    if (!child) throw new Error("Device is not attached to this conversation");
    child.dispose(); slots!.delete(alias); if (!slots!.size) this.additional.delete(sessionId);
  }
  rename(sessionId: string, value: string) {
    const c = this.connections.get(sessionId);
    if (!c) return;
    if (typeof value !== "string" || value.length > 120) throw new Error("Invalid device name");
    c.state.name = value.trim() || c.state.host;
    this.emit(c);
  }
  private emit(c: Connection) { if (this.connections.get(c.state.sessionId) === c) this.publish({ ...c.state, logs: [...c.state.logs] }); }
  private log(c: Connection, source: DeviceLog["source"], text: string, kind: DeviceLog["kind"] = "notice") {
    const last = c.state.logs.at(-1);
    if (kind === "output" && last?.kind === kind && last.source === source) {
      // Replace rather than mutate: already-published snapshots must stay stable.
      c.state.logs[c.state.logs.length - 1] = { ...last, text: (last.text + text).slice(-64000) };
    } else c.state.logs.push({ source, kind, text: text.slice(-16000), time: new Date().toISOString() });
    // Bound memory and the amount sent to the renderer.
    while (c.state.logs.length > 200 || c.state.logs.reduce((n, row) => n + row.text.length, 0) > 100000) c.state.logs.shift();
    this.emit(c);
  }
  async connect(sessionId: string, input: DeviceConfig): Promise<void> {
    if (!input || typeof input.host !== "string" || !/^[a-zA-Z0-9_.:\-\[\]]{1,253}$/.test(input.host) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || typeof input.username !== "string" || !input.username.trim() || input.username.length > 128 || typeof input.password !== "string" || input.password.length > 4096 || (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 120))) throw new Error("Invalid SSH settings");
    if (input.protocol !== undefined && input.protocol !== "ssh" && input.protocol !== "telnet") throw new Error("Invalid device protocol");
    if (input.protocol === "telnet") return this.connectTelnet(sessionId, input);
    this.disconnect(sessionId);
    const sshClient = new Client();
    const c: Connection = { client: sshClient, tail: "", state: { sessionId, connectionId: randomUUID(), name: input.name?.trim() || input.host, host: input.host, port: input.port, username: input.username, status: "connecting", busy: false, logs: [] } };
    this.connections.set(sessionId, c); this.emit(c);
    const decoder = new StringDecoder("utf8");
    const lost = (reason: string) => {
      const wasConnected = c.state.status !== "disconnected";
      c.state.status = "disconnected"; c.state.busy = false;
      c.pending?.fail(new Error(reason));
      if (wasConnected) this.log(c, "system", reason);
    };
    c.client.on("error", () => lost("SSH connection failed"));
    c.client.on("close", () => lost("SSH disconnected"));
    try {
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        let promptTimer: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => finish(new Error("SSH connection timed out")), 60000);
        const closed = () => finish(new Error("SSH disconnected"));
        const finish = (error?: Error) => {
          if (finished) return; finished = true; clearTimeout(timer); clearTimeout(promptTimer); c.client.off("close", closed);
          if (error) reject(error); else resolve();
        };
        c.client.once("close", closed);
        c.client.once("error", () => finish(new Error("SSH connection failed; check address and credentials")));
        c.client.once("ready", () => sshClient.shell({ term: "dumb", cols: 120, rows: 30 }, (error, shell) => {
          if (error) { finish(new Error("SSH shell unavailable")); return; }
          c.shell = shell;
          shell.on("data", (chunk: Buffer) => {
            const text = decoder.write(chunk);
            c.tail = (c.tail + text).slice(-4000);
            this.log(c, c.pending ? (c.source ?? "system") : "system", text, "output");
            if (!finished) {
              clearTimeout(promptTimer);
              const prompt = cliPrompt(c.tail);
              if (prompt) promptTimer = setTimeout(() => {
                c.state.prompt = prompt; c.state.status = "connected";
                this.log(c, "system", "SSH connected\n"); finish();
              }, 200);
            }
            c.pending?.data(text);
          });
          shell.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString("utf8"); this.log(c, "system", text); });
          shell.on("close", () => { lost("SSH shell closed; reconnect to continue"); c.client.end(); });
          shell.on("error", () => { lost("SSH shell error"); c.client.destroy(); });

        }));
        sshClient.connect({ host: input.host, port: input.port, username: input.username, password: input.password, readyTimeout: 60000,
          hostVerifier: (key: Buffer, verify: (accepted: boolean) => void) => {
            const fingerprint = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
            void this.trust(`${input.host}:${input.port}`, fingerprint).then((accepted) => verify(accepted && this.connections.get(sessionId) === c && c.state.status === "connecting"), () => verify(false));
          },
        });
      });
    } catch (error) { c.client.destroy(); lost("SSH connection failed"); throw error; }
  }
  private async connectTelnet(sessionId: string, input: DeviceConfig): Promise<void> {
    if (/[\r\n\x00-\x1f\x7f]/.test(input.username + input.password)) throw new Error("Telnet login does not accept control characters");
    this.disconnect(sessionId);
    const socket = new Socket(), protocol = new TelnetProtocol(), decoder = new StringDecoder("utf8");
    const c: Connection = { client: socket, shell: socket, tail: "", state: { sessionId, connectionId: randomUUID(), name: input.name?.trim() || input.host, host: input.host, port: input.port, username: input.username, protocol: "telnet", status: "connecting", busy: false, logs: [] } };
    this.connections.set(sessionId, c); this.emit(c);
    let loginSent = false, passwordSent = false, settled = false;
    let loginTail = "", quiet: NodeJS.Timeout | undefined;
    const lost = (reason: string) => {
      const active = c.state.status !== "disconnected"; c.state.status = "disconnected"; c.state.busy = false;
      c.pending?.fail(new Error(reason)); if (active) this.log(c, "system", reason);
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Telnet connection timed out")), 60000);
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(quiet); if (error) reject(error); else resolve(); };
        socket.on("error", () => { finish(new Error("Telnet connection failed")); lost("Telnet connection failed"); });
        socket.on("close", () => { finish(new Error("Telnet disconnected")); lost("Telnet disconnected"); });
        socket.on("data", (chunk: Buffer) => {
          const parsed = protocol.read(chunk); if (parsed.reply.length) socket.write(parsed.reply);
          const text = decoder.write(parsed.data); if (!text) return;
          if (!settled) {
            // Authentication traffic is never copied to device logs or the model.
            loginTail = (loginTail + text).slice(-4000);
            if (!loginSent && /(?:login|username)\s*:\s*$/i.test(loginTail)) { loginSent = true; loginTail = ""; socket.write(`${input.username}\r\n`); return; }
            if (!passwordSent && /password\s*:\s*$/i.test(loginTail)) { passwordSent = true; loginTail = ""; socket.write(`${input.password}\r\n`); return; }
            const prompt = cliPrompt(loginTail);
            clearTimeout(quiet);
            if (prompt) quiet = setTimeout(() => { c.state.prompt = prompt; c.state.status = "connected"; this.log(c, "system", "Telnet connected\n"); finish(); }, 250);
            return;
          }
          if (c.state.status !== "connected") return;
          c.tail = (c.tail + text).slice(-4000);
          this.log(c, c.pending ? (c.source ?? "system") : "system", text, "output"); c.pending?.data(text);
        });
        socket.connect(input.port, input.host);
      });
    } catch (error) { socket.destroy(); lost("Telnet connection failed"); throw error; }
  }
  async run(sessionId: string, command: unknown, source: "user" | "agent", onData: (text: string) => void = () => {}, signal?: AbortSignal): Promise<{ exitCode?: number; prompt?: string }> {
    if (typeof command !== "string" || !command.trim() || command.length > 32000 || command.includes("\0")) throw new Error("Invalid device command");
    const c = this.connections.get(sessionId);
    if (!c?.shell || c.state.status !== "connected") throw new Error("Connect an SSH device first");
    if (/[\r\n\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error("Device CLI accepts one command per call; submit commands separately");
    if (c.state.busy) throw new Error("Device is busy; wait or interrupt before manual input");
    if (signal?.aborted) throw new Error("Cancelled");
    c.state.busy = true;
    c.source = source;
    this.log(c, source, `\n${c.state.prompt ?? "$"} ${command}\n`, "input");
    try {
      return await new Promise((resolve, reject) => {
        let buffer = "";
        let quiet: NodeJS.Timeout | undefined;
        const cleanup = () => { clearTimeout(timer); clearTimeout(quiet); signal?.removeEventListener("abort", abort); delete c.pending; };
        const fail = (error: Error) => { cleanup(); reject(error); };
        const abort = () => { fail(new Error("Device command interrupted; reconnect to continue")); this.disconnect(sessionId); };
        const timer = setTimeout(() => { fail(new Error("Device command timed out; reconnect to continue")); this.disconnect(sessionId); }, 120000);
        c.pending = {
          fail,
          data: (text) => {
            buffer = (buffer + text).slice(-1000);
            onData(text);
            clearTimeout(quiet);
            if (cliConfirmation(buffer)) {
              quiet = setTimeout(() => { fail(new Error("Unexpected device confirmation prompt; no response sent; reconnect to continue")); this.disconnect(sessionId); }, 250);
              return;
            }
            if (cliPager(buffer)) {
              quiet = setTimeout(() => { fail(new Error("Device paging detected; output incomplete; reconnect to continue")); this.disconnect(sessionId); }, 250);
              return;
            }
            const prompt = cliPrompt(buffer) ?? (c.state.prompt && buffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd().endsWith(c.state.prompt) ? c.state.prompt : undefined);
            if (prompt && c.state.prompt && promptIdentity(prompt) === promptIdentity(c.state.prompt)) {
              quiet = setTimeout(() => { c.state.prompt = prompt; cleanup(); resolve({ prompt }); }, 250);
            }
          },
        };
        signal?.addEventListener("abort", abort, { once: true });
        c.shell!.write(`${command}${c.state.protocol === "telnet" ? "\r\n" : "\r"}`);
      });
    } finally { c.state.busy = false; this.emit(c); }
  }
  disconnect(id: string) {
    const c = this.connections.get(id); if (!c) return;
    c.state.status = "disconnected"; c.state.busy = false;
    c.pending?.fail(new Error("Device disconnected")); c.client.destroy(); this.emit(c);
  }
  remove(id: string) { this.pendingAdditional.get(id)?.dispose(); this.pendingAdditional.delete(id); for (const child of this.additional.get(id)?.values() ?? []) child.dispose(); this.additional.delete(id); this.disconnect(id); this.connections.delete(id); for (const [token, session] of this.tokens) if (session === id) this.tokens.delete(token); }
  dispose() { for (const child of this.pendingAdditional.values()) child.dispose(); this.pendingAdditional.clear(); for (const slots of this.additional.values()) for (const child of slots.values()) child.dispose(); this.additional.clear(); for (const id of this.connections.keys()) this.disconnect(id); this.server?.closeAllConnections(); this.server?.close(); }
}
