import type { HarnessSessionMetadata } from "../core/session-manager.js";
import type { TaskIntent } from "../core/execution-controller.js";
import type { ExtensionUiResponse, PiSessionState, RuntimeEvent } from "../runtime/types.js";

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

export interface DesktopApi {
  chooseProject(): Promise<string | null>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(projectDir: string, name?: string): Promise<SessionSnapshot>;
  openSession(id: string): Promise<SessionSnapshot>;
  renameSession(id: string, name: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  prompt(id: string, message: string, intent: TaskIntent): Promise<{ runId: string; taskId: string }>;
  abort(id: string): Promise<void>;
  listModels(id: string): Promise<ModelOption[]>;
  setModel(id: string, provider: string, modelId: string): Promise<void>;
  respondToExtensionUi(id: string, response: ExtensionUiResponse): Promise<void>;
  onRuntimeEvent(listener: (event: RuntimeEvent) => void): () => void;
  onSessionsChanged(listener: (sessions: SessionSummary[]) => void): () => void;
}
