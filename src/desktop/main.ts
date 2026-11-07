import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, basename } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { HarnessSessionManager } from "../core/session-manager.js";
import { ExecutionController, type TaskIntent } from "../core/execution-controller.js";
import type { ImageAttachment, PiRuntimeAdapter, RuntimeEvent } from "../runtime/types.js";
import type { ExecutionStatus, SessionSnapshot, SessionSummary } from "./ipc-contract.js";
import { ContextStore, activeBranch, listContextItems, roundEntryIds, type ContextEdit } from "./context-management.js";
import { ExtensionStore } from "./extensions.js";
import { discoverWorkspace } from "./workspace-discovery.js";
import { resolvePiCommand } from "./pi-command.js";
import { DeviceBroker } from "./devices.js";
import { DeviceProfileStore } from "./device-profiles.js";
import { PiRpcAdapter } from "../runtime/pi-rpc-adapter.js";

let window: BrowserWindow | undefined;
let manager: HarnessSessionManager;
let execution: ExecutionController;
let extensions: ExtensionStore;
let contextStore: ContextStore;
let devices: DeviceBroker;
let deviceProfiles: DeviceProfileStore;
let quitting = false;
const statuses = new Map<string, ExecutionStatus>();
const contextUpdating = new Set<string>();
const subscriptions = new Map<string, () => void>();
const authorizedProjects = new Map<string, string>();
let projectIndexPath: string;
let projectWrites = Promise.resolve();

async function saveProjects(): Promise<void> {
  const content = JSON.stringify([...authorizedProjects].map(([path, name]) => ({ path, name })));
  projectWrites = projectWrites.catch(() => {}).then(() => writeFile(projectIndexPath, content));
  await projectWrites;
}

function requireSession(id: unknown): string {
  if (typeof id !== "string" || !manager.list().some((session) => session.id === id)) throw new Error("Invalid session ID");
  return id;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${label} must be between 1 and ${maxLength} characters`);
  return trimmed;
}

async function requireProject(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value) || !authorizedProjects.has(value)) throw new Error("Project was not selected by the user");
  if (!(await stat(value)).isDirectory()) throw new Error("Project path is not a directory");
  return value;
}

async function selectedPi() {
  return resolvePiCommand({ ...(process.env.PI_PATH ? { override: process.env.PI_PATH } : {}), appPath: app.getAppPath(), executable: process.execPath });
}

function summaries(): SessionSummary[] {
  return manager.list().map((metadata) => ({
    ...metadata,
    status: statuses.get(metadata.id) ?? "Idle",
  }));
}

function publishSessions(): void {
  window?.webContents.send("sessions:changed", summaries());
}

function bindRuntime(id: string, runtime: PiRuntimeAdapter): void {
  if (subscriptions.has(id)) return;
  subscriptions.set(id, runtime.subscribe((event) => {
    const type = event.record.type;
    if (type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.record.method))) {
      statuses.set(id, "WaitingForUser");
    }
    if (type === "agent_settled") execution.release(id);
    if (type === "runtime_process_exit") execution.fail(id);
    window?.webContents.send("runtime:event", event);
    if ((type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(String(event.record.method))) || type === "agent_settled") publishSessions();
  }));
}

async function openSnapshot(id: string): Promise<SessionSnapshot> {
  const { metadata, state } = await manager.open(id);
  const runtime = manager.runtime(id);
  if (!runtime) throw new Error("Runtime did not open");
  bindRuntime(id, runtime);
  return { metadata, state, messages: await runtime.getMessages(), status: statuses.get(id) ?? "Idle" };
}

function registerIpc(): void {
  ipcMain.handle("device-profiles:list", (_event, id) => deviceProfiles.list(requireSession(id)));
  ipcMain.handle("device-profiles:save", (_event, id, profile) => deviceProfiles.save(requireSession(id), profile));
  ipcMain.handle("device-profiles:remove", (_event, id, profileId) => deviceProfiles.remove(requireSession(id), profileId));
  ipcMain.handle("devices:list", () => devices.list());
  ipcMain.handle("devices:rename", (_event, id, name) => { id = requireSession(id); if (execution.has(id)) throw new Error("Wait for the Agent to finish before renaming the device"); devices.rename(id, name); });
  ipcMain.handle("devices:connect", async (_event, id, config) => {
    id = requireSession(id);
    if (execution.has(id)) throw new Error("Wait for the Agent to finish before changing devices");
    await devices.connect(id, config);
  });
  ipcMain.handle("devices:disconnect", (_event, id) => devices.disconnect(requireSession(id)));
  ipcMain.handle("devices:command", async (_event, id, command) => {
    id = requireSession(id);
    if (execution.has(id)) throw new Error("Wait for the Agent to finish before manual input");
    await devices.run(id, command, "user");
  });
  ipcMain.handle("auth:list-stored", async () => {
    const authPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "auth.json");
    let raw: string;
    try { raw = await readFile(authPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("Unable to read provider credentials"); }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error("Unable to read provider credentials: invalid configuration"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unable to read provider credentials: invalid configuration");
    return Object.entries(data).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value)).map(([provider]) => provider).sort();
  });
  ipcMain.handle("auth:open-terminal", async () => {
    if (process.platform !== "darwin") throw new Error("Opening a terminal is currently supported on macOS only. Run pi in your terminal instead.");
    const pi = await selectedPi();
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = (pi.env?.ELECTRON_RUN_AS_NODE ? "export ELECTRON_RUN_AS_NODE=1; " : "") + "exec " + [pi.path, ...pi.args].map(quote).join(" ");
    await promisify(execFile)("osascript", ["-e", "on run argv", "-e", "tell application \"Terminal\"", "-e", "activate", "-e", "do script (item 1 of argv)", "-e", "end tell", "-e", "end run", command]);
  });
  ipcMain.handle("app:open-external", async (_event, value: unknown) => {
    if (typeof value !== "string" || value.length > 4096) throw new Error("Invalid URL");
    const url = new URL(value);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) throw new Error("Unsupported URL");
    await shell.openExternal(url.href);
  });
  ipcMain.handle("project:choose", async () => {
    let defaultPath: string | undefined;
    if (process.platform === "win32") {
      try {
        const { stdout } = await promisify(execFile)("reg.exe", ["query", "HKCU\\Network", "/s"]);
        const mappings: Array<{ drive: string; path: string }> = [];
        let drive = "";
        for (const line of stdout.split(/\r?\n/)) {
          const key = line.match(/^HKEY_CURRENT_USER\\Network\\([A-Za-z])\s*$/i);
          if (key?.[1]) drive = key[1].toUpperCase();
          const remote = line.match(/^\s*RemotePath\s+REG_\w+\s+(\\\\.+?)\s*$/i);
          if (drive && remote?.[1]) mappings.push({ drive, path: remote[1] });
        }
        if (mappings.length) {
          const choice = await dialog.showMessageBox(window!, {
            type: "question",
            message: "Choose a location / 选择位置",
            detail: "Mapped network drives are opened using their network paths. / 映射的网络驱动器将通过网络路径打开。",
            buttons: ["Other location / 其他位置", ...mappings.map((mapping) => `${mapping.drive}:  ${mapping.path}`), "Cancel / 取消"],
            defaultId: 0,
            cancelId: mappings.length + 1,
            noLink: true,
          });
          if (choice.response === mappings.length + 1) return null;
          if (choice.response > 0) defaultPath = mappings[choice.response - 1]?.path;
        }
      } catch { /* No saved mappings or registry access unavailable. */ }
    }
    const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory", "createDirectory"], ...(defaultPath ? { defaultPath } : {}) });
    const selected = result.canceled ? undefined : result.filePaths[0];
    if (selected) { if (!authorizedProjects.has(selected)) authorizedProjects.set(selected, basename(selected) || selected); await saveProjects(); }
    return selected ?? null;
  });
  ipcMain.handle("project:list", () => [...authorizedProjects].map(([path, name]) => ({ path, name })));
  ipcMain.handle("project:rename", async (_event, path: unknown, value: unknown) => {
    if (typeof path !== "string" || !authorizedProjects.has(path)) throw new Error("Invalid project");
    const name = requireText(value, "Project name", 120);
    authorizedProjects.set(path, name);
    await saveProjects();
  });
  ipcMain.handle("project:remove", async (_event, path: unknown) => {
    if (typeof path !== "string" || !authorizedProjects.has(path)) throw new Error("Invalid project");
    authorizedProjects.delete(path);
    await saveProjects();
  });
  ipcMain.handle("sessions:list", () => summaries());
  ipcMain.handle("sessions:create", async (_event, projectDir: string, name?: string) => {
    const project = await requireProject(projectDir);
    const sessionName = name == null ? "New session" : requireText(name, "Session name", 120);
    const created = await manager.create(project, sessionName);
    const runtime = manager.runtime(created.metadata.id)!;
    bindRuntime(created.metadata.id, runtime);
    statuses.set(created.metadata.id, "Idle");
    publishSessions();
    return { ...created, messages: [], status: "Idle" } satisfies SessionSnapshot;
  });
  ipcMain.handle("sessions:open", (_event, id: string) => openSnapshot(requireSession(id)));
  ipcMain.handle("sessions:rename", async (_event, id: string, name: string) => {
    await manager.renameSession(requireSession(id), requireText(name, "Session name", 120));
    publishSessions();
  });
  ipcMain.handle("sessions:delete", async (_event, id: string) => {
    id = requireSession(id);
    if (execution.has(id)) throw new Error("Stop or cancel the task before deleting its session");
    subscriptions.get(id)?.();
    subscriptions.delete(id);
    statuses.delete(id);
    const piSessionId = manager.list().find((session) => session.id === id)!.piSessionId;
    devices.remove(id);
    await manager.deleteSession(id);
    await deviceProfiles.removeSession(id);
    await contextStore.remove(piSessionId);
    publishSessions();
  });
  ipcMain.handle("runtime:prompt", async (_event, id: string, message: string, intent: TaskIntent, images?: ImageAttachment[]) => {
    id = requireSession(id);
    if (contextUpdating.has(id)) throw new Error("Context update is in progress");
    if (devices.list().some((device) => device.sessionId === id && (device.busy || device.status === "connecting"))) throw new Error("Wait for the device connection or manual command to finish");
    if (typeof message !== "string" || message.length > 2_000_000) throw new Error("Invalid prompt");
    message = message.trim();
    if (images !== undefined && (!Array.isArray(images) || images.length > 4 || images.some((image) => !image || image.type !== "image" || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType) || typeof image.data !== "string" || image.data.length > 13_981_016 || (!image.data.length || image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))))) throw new Error("Invalid images");
    if (!message && !images?.length) throw new Error("Prompt is empty");
    if (intent !== "analysis" && intent !== "write") throw new Error("Invalid task intent");
    const runtime = manager.runtime(id) ?? (await manager.open(id), manager.runtime(id));
    if (!runtime) throw new Error("Runtime unavailable");
    bindRuntime(id, runtime);
    const metadata = manager.list().find((session) => session.id === id);
    if (!metadata) throw new Error("Session metadata unavailable");
    const savedContext = await contextStore.read(metadata.piSessionId);
    if (Object.keys(savedContext).length && !(await runtime.getCommands()).some((command) => command.source === "extension" && command.name === "harness-context-filter-ready")) throw new Error("Context filter is unavailable; restart the application before sending");
    if (contextUpdating.has(id)) throw new Error("Context update is in progress");
    try {
      const lease = await execution.acquire({ sessionId: id, projectDir: metadata.projectDir, intent });
      const result = await runtime.prompt(message, images);
      if (result.disposition === "handled") lease.release();
      return { runId: result.runId, taskId: lease.taskId };
    } catch (error) {
      if (!String(error).includes("Queued task cancelled")) execution.fail(id);
      throw error;
    }
  });
  ipcMain.handle("runtime:abort", async (_event, id: string) => {
    id = requireSession(id);
    if (execution.cancelQueued(id)) return;
    const runtime = manager.runtime(id);
    if (!runtime) return;
    execution.markStopping(id);
    await runtime.abort();
  });
  ipcMain.handle("runtime:list-models", async (_event, id: string) => {
    id = requireSession(id);
    const runtime = manager.runtime(id) ?? (await manager.open(id), manager.runtime(id));
    if (!runtime) throw new Error("Runtime unavailable");
    return runtime.getAvailableModels();
  });
  ipcMain.handle("runtime:context-usage", async (_event, id: string) => {
    id = requireSession(id);
    const runtime = manager.runtime(id);
    if (!runtime) throw new Error("Runtime unavailable");
    return runtime.getContextUsage();
  });
  const getContext = async (sessionId: string) => {
    const metadata = manager.list().find((session) => session.id === sessionId)!;
    const runtime = manager.runtime(sessionId); if (!runtime) throw new Error("Session runtime unavailable");
    const { entries, leafId } = await runtime.getEntries();
    const edits = await contextStore.read(metadata.piSessionId);
    return { metadata, edits, entries, leafId, items: listContextItems(entries, leafId, edits) };
  };
  ipcMain.handle("context:list", async (_event, id: unknown) => (await getContext(requireSession(id))).items);
  ipcMain.handle("context:update", async (_event, sessionId: unknown, entryId: unknown, edit: unknown) => {
    const id = requireSession(sessionId);
    if (execution.has(id) || contextUpdating.has(id)) throw new Error("Wait until the session is idle");
    contextUpdating.add(id);
    try {
    if (typeof entryId !== "string" || !entryId || entryId.length > 200) throw new Error("Invalid message ID");
    const context = await getContext(id);
    const runtime = manager.runtime(id)!;
    if (!(await runtime.getCommands()).some((command) => command.source === "extension" && command.name === "harness-context-filter-ready")) throw new Error("Context filter is unavailable; restart the application");
    const item = context.items.find((value) => value.id === entryId);
    if (!item?.editable) throw new Error("This message cannot be edited in the current context");
    if (edit === null) {
      if (context.edits[entryId]?.roundExcluded) context.edits[entryId] = { excluded: false, roundExcluded: true };
      else delete context.edits[entryId];
    }
    else {
      if (!edit || typeof edit !== "object" || typeof (edit as ContextEdit).excluded !== "boolean") throw new Error("Invalid context edit");
      const value = edit as ContextEdit;
      if (value.text !== undefined && (typeof value.text !== "string" || !value.text.trim() || value.text.length > 100_000)) throw new Error("Invalid message text");
      context.edits[entryId] = { excluded: value.excluded, ...(context.edits[entryId]?.roundExcluded ? { roundExcluded: true } : {}), ...(value.text !== undefined && value.text !== item.original ? { text: value.text } : {}) };
    }
    if (execution.has(id)) throw new Error("Wait until the session is idle");
    await contextStore.write(context.metadata.piSessionId, context.edits);
    return (await getContext(id)).items;
    } finally { contextUpdating.delete(id); }
  });
  ipcMain.handle("context:round", async (_event, sessionId: unknown, entryId: unknown, excluded: unknown) => {
    const id = requireSession(sessionId);
    if (execution.has(id) || contextUpdating.has(id)) throw new Error("Wait until the session is idle");
    if (typeof entryId !== "string" || typeof excluded !== "boolean") throw new Error("Invalid round");
    contextUpdating.add(id);
    try {
      const context = await getContext(id);
      if (!context.items.find((item) => item.id === entryId)?.roundAvailable) throw new Error("This round cannot be safely adjusted");
      if (!(await manager.runtime(id)!.getCommands()).some((command) => command.source === "extension" && command.name === "harness-context-filter-ready")) throw new Error("Context filter is unavailable; restart the application");
      for (const targetId of roundEntryIds(activeBranch(context.entries, context.leafId), entryId)) {
        const current = context.edits[targetId];
        if (excluded) context.edits[targetId] = { ...(current ?? { excluded: false }), roundExcluded: true };
        else if (current?.roundExcluded) {
          const { roundExcluded: _discard, ...rest } = current;
          if (!rest.excluded && rest.text === undefined) delete context.edits[targetId]; else context.edits[targetId] = rest;
        }
      }
      if (execution.has(id)) throw new Error("Wait until the session is idle");
      await contextStore.write(context.metadata.piSessionId, context.edits);
      return (await getContext(id)).items;
    } finally { contextUpdating.delete(id); }
  });
  ipcMain.handle("extensions:list", () => extensions.list());
  ipcMain.handle("extensions:add", async (_event, kind: unknown) => {
    if (kind !== "file" && kind !== "directory") throw new Error("Invalid extension source");
    const result = await dialog.showOpenDialog(window!, { properties: [kind === "file" ? "openFile" : "openDirectory"], ...(kind === "file" ? { filters: [{ name: "Pi extensions", extensions: ["ts", "js", "mjs", "mts"] }] } : {}) });
    if (!result.canceled && result.filePaths[0]) await extensions.add(result.filePaths[0]);
    return extensions.list();
  });
  ipcMain.handle("extensions:add-network", async (_event, source: unknown) => {
    if (typeof source !== "string") throw new Error("Invalid network source");
    await extensions.addNetwork(source, await selectedPi()); return extensions.list();
  });
  ipcMain.handle("extensions:enable", async (_event, path: unknown, enabled: unknown) => {
    if (typeof path !== "string" || typeof enabled !== "boolean") throw new Error("Invalid extension");
    await extensions.setEnabled(path, enabled); return extensions.list();
  });
  ipcMain.handle("extensions:remove", async (_event, path: unknown) => {
    if (typeof path !== "string") throw new Error("Invalid extension");
    await extensions.remove(path); return extensions.list();
  });
  ipcMain.handle("workspace:discover", async (_event, id: string) => {
    id = requireSession(id);
    const metadata = manager.list().find((session) => session.id === id)!;
    const result = await discoverWorkspace(metadata.projectDir, process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
    try {
      const runtime = manager.runtime(id);
      if (!runtime) throw new Error("Session runtime is not open");
      result.skills = (await runtime.getCommands()).filter((command) => command.source === "skill").map(({ name, description }) => ({ name, ...(description ? { description } : {}) }));
    } catch (error) { result.skillError = error instanceof Error ? error.message : String(error); }
    return result;
  });
  ipcMain.handle("runtime:set-model", async (_event, id: string, provider: string, modelId: string) => {
    id = requireSession(id);
    provider = requireText(provider, "Provider", 200);
    modelId = requireText(modelId, "Model ID", 500);
    const runtime = manager.runtime(id) ?? (await manager.open(id), manager.runtime(id));
    await runtime?.setModel(provider, modelId);
  });
  ipcMain.handle("runtime:extension-ui", async (_event, id: string, response) => {
    id = requireSession(id);
    if (!response || typeof response !== "object" || response.type !== "extension_ui_response" || typeof response.id !== "string") {
      throw new Error("Invalid Extension UI response");
    }
    const runtime = manager.runtime(id);
    if (!runtime) throw new Error("Runtime unavailable");
    await runtime.respondToExtensionUi(response);
    statuses.set(id, "Running");
    publishSessions();
  });
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: "Minimal Pi Harness",
    backgroundColor: "#111310",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.error(`Preload failed at ${preloadPath}:`, error);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });
  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else if (!app.isPackaged && process.env.NODE_ENV === "development") {
    await window.loadURL("http://localhost:5173");
  } else {
    await window.loadFile(join(import.meta.dirname, "../../dist-renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  deviceProfiles = new DeviceProfileStore(join(app.getPath("userData"), "harness-state", "device-profiles.json"));
  await deviceProfiles.load();
  const trustedHosts = new Map<string, string>();
  devices = new DeviceBroker((state) => window?.webContents.send("devices:changed", state), async (host, fingerprint) => {
    if (trustedHosts.get(host) === fingerprint) return true;
    const result = await dialog.showMessageBox(window!, {
      type: "question", message: `SSH 主机验证 / Verify SSH host: ${host}`,
      detail: `${trustedHosts.has(host) ? "主机密钥已变更 / Host key changed\n" : ""}${fingerprint}\n请核对设备指纹后连接。 / Verify this fingerprint with your device.`,
      buttons: ["取消 / Cancel", "信任并连接 / Trust and connect"], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) return false;
    trustedHosts.set(host, fingerprint); return true;
  });
  await devices.start();
  contextStore = new ContextStore(join(app.getPath("userData"), "harness-state", "context-edits"));
  extensions = new ExtensionStore(join(app.getPath("userData"), "harness-state", "extensions.json"));
  await extensions.load();
  const pi = await selectedPi();
  manager = new HarnessSessionManager({
    storageDir: join(app.getPath("userData"), "harness-state"),
    piPath: pi.path,
    piExecutableArgs: pi.args,
    ...(pi.env ? { piEnv: pi.env } : {}),
    extensionPaths: () => extensions.enabledPaths(),
    adapterFactory: (options) => new PiRpcAdapter({ ...options,
      piEnv: { ...options.piEnv, ...devices.environment(options.harnessSessionId) },
      extraArgs: [...(options.extraArgs ?? []), "--extension", join(import.meta.dirname, "../runtime/device-tools.js")],
    }),
  });
  execution = new ExecutionController({
    maxConcurrent: 2,
    onStateChange: (id, state) => {
      statuses.set(id, state);
      publishSessions();
    },
  });
  await manager.load();
  const stateDir = join(app.getPath("userData"), "harness-state");
  await mkdir(stateDir, { recursive: true });
  projectIndexPath = join(stateDir, "projects.json");
  try {
    const stored: unknown = JSON.parse(await readFile(projectIndexPath, "utf8"));
    if (!Array.isArray(stored)) throw new Error("Invalid project index");
    for (const item of stored) {
      const path = typeof item === "string" ? item : item?.path;
      const name = typeof item === "string" ? basename(item) || item : item?.name;
      if (typeof path !== "string" || !isAbsolute(path) || typeof name !== "string" || !name.trim() || name.length > 120) throw new Error("Invalid project index");
      authorizedProjects.set(path, name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const session of manager.list()) authorizedProjects.set(session.projectDir, basename(session.projectDir) || session.projectDir);
    await saveProjects();
  }
  registerIpc();
  await createWindow();
  if (process.env.HARNESS_SMOKE_TEST === "1") {
    const result = await window!.webContents.executeJavaScript(`({
      title: document.title,
      text: document.body.innerText,
      hasApi: typeof window.piHarness?.listSessions === "function",
      nodeExposed: typeof window.require !== "undefined" || typeof window.process !== "undefined"
    })`);
    console.log(`HARNESS_SMOKE ${JSON.stringify(result)}`);
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    for (const session of manager.list()) execution.cancelQueued(session.id);
    const running = manager.list()
      .filter((session) => ["Running", "WaitingForUser", "Stopping"].includes(statuses.get(session.id) ?? ""))
      .map((session) => manager.runtime(session.id)?.abort());
    await Promise.allSettled(running);
    await manager.dispose();
    devices.dispose();
    app.quit();
  })();
});

app.on("window-all-closed", () => app.quit());
