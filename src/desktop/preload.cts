import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, SessionSummary } from "./ipc-contract.js";
import type { RuntimeEvent } from "../runtime/types.js";

const api: DesktopApi = {
  chooseProject: () => ipcRenderer.invoke("project:choose") as Promise<string | null>,
  listSessions: () => ipcRenderer.invoke("sessions:list") as Promise<SessionSummary[]>,
  createSession: (projectDir, name) => ipcRenderer.invoke("sessions:create", projectDir, name),
  openSession: (id) => ipcRenderer.invoke("sessions:open", id),
  renameSession: (id, name) => ipcRenderer.invoke("sessions:rename", id, name),
  deleteSession: (id) => ipcRenderer.invoke("sessions:delete", id),
  prompt: (id, message, intent) => ipcRenderer.invoke("runtime:prompt", id, message, intent),
  abort: (id) => ipcRenderer.invoke("runtime:abort", id),
  listModels: (id) => ipcRenderer.invoke("runtime:list-models", id),
  setModel: (id, provider, modelId) => ipcRenderer.invoke("runtime:set-model", id, provider, modelId),
  respondToExtensionUi: (id, response) => ipcRenderer.invoke("runtime:extension-ui", id, response),
  onRuntimeEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: RuntimeEvent) => listener(value);
    ipcRenderer.on("runtime:event", wrapped);
    return () => ipcRenderer.off("runtime:event", wrapped);
  },
  onSessionsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: SessionSummary[]) => listener(value);
    ipcRenderer.on("sessions:changed", wrapped);
    return () => ipcRenderer.off("sessions:changed", wrapped);
  },
};

contextBridge.exposeInMainWorld("piHarness", api);
