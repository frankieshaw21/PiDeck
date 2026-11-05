export type RpcCommand = { id?: string; type: string; [key: string]: unknown };

export type RpcResponse = {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
};

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export type RpcRecord = Record<string, unknown> & { type: string };

export interface PiSessionState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  pendingMessageCount: number;
  model?: { provider: string; id: string; name?: string };
}

export type PromptDisposition = "started" | "queued" | "handled";

export interface RuntimeEvent {
  harnessSessionId: string;
  runId?: string;
  sequence: number;
  record: RpcRecord;
}

export interface PiRuntimeAdapter {
  readonly harnessSessionId: string;
  start(): Promise<PiSessionState>;
  prompt(message: string): Promise<{ disposition: PromptDisposition; runId: string }>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<unknown[]>;
  setSessionName(name: string): Promise<void>;
  getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string }>>;
  getCommands(): Promise<Array<{ name: string; source: "extension" | "prompt" | "skill"; description?: string }>>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  respondToExtensionUi(response: ExtensionUiResponse): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}
