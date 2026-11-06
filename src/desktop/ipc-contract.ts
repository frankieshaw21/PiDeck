import type { ContextItem } from "./context-management.js";
import type { ManagedExtension } from "./extensions.js";
import type { HarnessSessionMetadata } from "../core/session-manager.js";
import type { TaskIntent } from "../core/execution-controller.js";
import type { ContextUsage, ExtensionUiResponse, ImageAttachment, PiSessionState, RuntimeEvent } from "../runtime/types.js";

export type ExecutionStatus = "Idle" | "Queued" | "Running" | "WaitingForUser" | "Stopping" | "Failed";

export interface SessionSummary extends HarnessSessionMetadata {
  status: ExecutionStatus;
  model?: string;
}

export interface SessionSnapshot {
  metadata: HarnessSessionMetadata;
  state: PiSessionState;
  messages: unknown[];
  status: ExecutionStatus;
}

export interface ModelOption { provider: string; id: string; name?: string }

export interface WorkspaceDiscovery {
  connections: Array<{ name: string; scope: "global" | "project"; path: string }>;
  instructions: Array<{ name: string; scope: "global" | "project"; path: string }>;
  warnings: Array<{ path: string; message: string }>;
  skills?: Array<{ name: string; description?: string }>;
  skillError?: string;
}

export interface ProjectSummary { path: string; name: string }

export interface DesktopApi {
  listStoredAuth(): Promise<string[]>;
  openAuthTerminal(): Promise<void>;
  openExternal(url: string): Promise<void>;
  chooseProject(): Promise<string | null>;
  listProjects(): Promise<ProjectSummary[]>;
  renameProject(path: string, name: string): Promise<void>;
  removeProject(path: string): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(projectDir: string, name?: string): Promise<SessionSnapshot>;
  openSession(id: string): Promise<SessionSnapshot>;
  renameSession(id: string, name: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  prompt(id: string, message: string, intent: TaskIntent, images?: ImageAttachment[]): Promise<{ runId: string; taskId: string }>;
  abort(id: string): Promise<void>;
  listModels(id: string): Promise<ModelOption[]>;
  getContextUsage(id: string): Promise<ContextUsage | null>;
  listContextItems(id: string): Promise<ContextItem[]>;
  setContextRound(id: string, entryId: string, excluded: boolean): Promise<ContextItem[]>;
  updateContextItem(id: string, entryId: string, edit: { excluded: boolean; text?: string } | null): Promise<ContextItem[]>;
  discoverWorkspace(id: string): Promise<WorkspaceDiscovery>;
  listExtensions(): Promise<ManagedExtension[]>;
  addExtension(kind: "file" | "directory"): Promise<ManagedExtension[]>;
  addNetworkExtension(source: string): Promise<ManagedExtension[]>;
  setExtensionEnabled(path: string, enabled: boolean): Promise<ManagedExtension[]>;
  removeExtension(path: string): Promise<ManagedExtension[]>;
  setModel(id: string, provider: string, modelId: string): Promise<void>;
  respondToExtensionUi(id: string, response: ExtensionUiResponse): Promise<void>;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;
}
