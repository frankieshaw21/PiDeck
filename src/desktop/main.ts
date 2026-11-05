import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { HarnessSessionManager } from "../core/session-manager.js";
import { ExecutionController, type TaskIntent } from "../core/execution-controller.js";
import type { PiRuntimeAdapter, RuntimeEvent } from "../runtime/types.js";
import type { ExecutionStatus, SessionSnapshot, SessionSummary } from "./ipc-contract.js";

let window: BrowserWindow | undefined;
let manager: HarnessSessionManager;
let execution: ExecutionController;
let quitting = false;
const statuses = new Map<string, ExecutionStatus>();
const subscriptions = new Map<string, () => void>();
const authorizedProjects = new Set<string>();

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

async function resolvePiPath(): Promise<string> {
  if (process.env.PI_PATH) return process.env.PI_PATH;
  const managed = join(homedir(), ".local", "bin", "pi");
  try {
    await access(managed);
    return managed;
  } catch {
    return "pi";
  }
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
  ipcMain.handle("project:choose", async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ["openDirectory", "createDirectory"] });
    const selected = result.canceled ? undefined : result.filePaths[0];
    if (selected) authorizedProjects.add(selected);
    return selected ?? null;
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
    await manager.deleteSession(id);
    publishSessions();
  });
  ipcMain.handle("runtime:prompt", async (_event, id: string, message: string, intent: TaskIntent) => {
    id = requireSession(id);
    message = requireText(message, "Prompt", 2_000_000);
    if (intent !== "analysis" && intent !== "write") throw new Error("Invalid task intent");
    const runtime = manager.runtime(id) ?? (await manager.open(id), manager.runtime(id));
    if (!runtime) throw new Error("Runtime unavailable");
    bindRuntime(id, runtime);
    const metadata = manager.list().find((session) => session.id === id);
    if (!metadata) throw new Error("Session metadata unavailable");
    try {
      const lease = await execution.acquire({ sessionId: id, projectDir: metadata.projectDir, intent });
      const result = await runtime.prompt(message);
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
  manager = new HarnessSessionManager({
    storageDir: join(app.getPath("userData"), "harness-state"),
    piPath: await resolvePiPath(),
  });
  execution = new ExecutionController({
    maxConcurrent: 2,
    onStateChange: (id, state) => {
      statuses.set(id, state);
      publishSessions();
    },
  });
  await manager.load();
  for (const session of manager.list()) authorizedProjects.add(session.projectDir);
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
    app.quit();
  })();
});

app.on("window-all-closed", () => app.quit());
