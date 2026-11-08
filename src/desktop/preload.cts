import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, SessionSummary } from "./ipc-contract.js";
import type { RuntimeEvent } from "../runtime/types.js";

const api: DesktopApi = {
  listDeviceProfiles: (id) => ipcRenderer.invoke("device-profiles:list", id),
  saveDeviceProfile: (id, profile) => ipcRenderer.invoke("device-profiles:save", id, profile),
  removeDeviceProfile: (id, profileId) => ipcRenderer.invoke("device-profiles:remove", id, profileId),
  listDevices: () => ipcRenderer.invoke("devices:list"),
  listConversationDevices: (id) => ipcRenderer.invoke("devices:list-session", id),
  addConversationDevice: (id, config) => ipcRenderer.invoke("devices:add-session", id, config),
  removeConversationDevice: (id, alias) => ipcRenderer.invoke("devices:remove-session", id, alias),
  renameConnectedDevice: (id, name) => ipcRenderer.invoke("devices:rename", id, name),
  connectDevice: (id, config) => ipcRenderer.invoke("devices:connect", id, config),
  disconnectDevice: (id) => ipcRenderer.invoke("devices:disconnect", id),
  deviceCommand: (id, command) => ipcRenderer.invoke("devices:command", id, command),
  onDeviceChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on("devices:changed", wrapped);
    return () => ipcRenderer.off("devices:changed", wrapped);
  },
  listStoredAuth: () => ipcRenderer.invoke("auth:list-stored"),
  openAuthTerminal: () => ipcRenderer.invoke("auth:open-terminal"),
  openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  chooseProject: () => ipcRenderer.invoke("project:choose") as Promise<string | null>,
  listProjects: () => ipcRenderer.invoke("project:list"),
  renameProject: (path, name) => ipcRenderer.invoke("project:rename", path, name),
  removeProject: (path) => ipcRenderer.invoke("project:remove", path),
  listSessions: () => ipcRenderer.invoke("sessions:list") as Promise<SessionSummary[]>,
  createSession: (projectDir, name) => ipcRenderer.invoke("sessions:create", projectDir, name),
  openSession: (id) => ipcRenderer.invoke("sessions:open", id),
  previewSession: (id) => ipcRenderer.invoke("sessions:preview", id),
  renameSession: (id, name) => ipcRenderer.invoke("sessions:rename", id, name),
  deleteSession: (id) => ipcRenderer.invoke("sessions:delete", id),
  prompt: (id, message, intent, images) => ipcRenderer.invoke("runtime:prompt", id, message, intent, images),
  abort: (id) => ipcRenderer.invoke("runtime:abort", id),
  listModels: (id) => ipcRenderer.invoke("runtime:list-models", id),
  getContextUsage: (id) => ipcRenderer.invoke("runtime:context-usage", id),
  listContextItems: (id) => ipcRenderer.invoke("context:list", id),
  setContextRound: (id, entryId, excluded) => ipcRenderer.invoke("context:round", id, entryId, excluded),
  updateContextItem: (id, entryId, edit) => ipcRenderer.invoke("context:update", id, entryId, edit),
  discoverWorkspace: (id) => ipcRenderer.invoke("workspace:discover", id),
  listExtensions: () => ipcRenderer.invoke("extensions:list"),
  addExtension: (kind) => ipcRenderer.invoke("extensions:add", kind),
  addNetworkExtension: (source) => ipcRenderer.invoke("extensions:add-network", source),
  setExtensionEnabled: (path, enabled) => ipcRenderer.invoke("extensions:enable", path, enabled),
  removeExtension: (path) => ipcRenderer.invoke("extensions:remove", path),
  setModel: (id, provider, modelId) => ipcRenderer.invoke("runtime:set-model", id, provider, modelId),
  getThinkingSettings: (id) => ipcRenderer.invoke("runtime:thinking-settings", id),
  setThinkingLevel: (id, level) => ipcRenderer.invoke("runtime:set-thinking-level", id, level),
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
