export type RpcCommand = { id?: string; type: string; [key: string]: unknown };
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];

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
  thinkingLevel?: ThinkingLevel;
  model?: { provider: string; id: string; name?: string };
}

export interface ContextUsage { tokens: number | null; contextWindow: number; percent: number | null }

export interface ImageAttachment { type: "image"; mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }

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
  prompt(message: string, images?: ImageAttachment[]): Promise<{ disposition: PromptDisposition; runId: string }>;
  abort(): Promise<void>;
  getState(): Promise<PiSessionState>;
  getMessages(): Promise<unknown[]>;
  getEntries(): Promise<{ entries: Record<string, unknown>[]; leafId: string | null }>;
  getContextUsage(): Promise<ContextUsage | null>;
  setSessionName(name: string): Promise<void>;
  getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string }>>;
  getCommands(): Promise<Array<{ name: string; source: "extension" | "prompt" | "skill"; description?: string }>>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  getAvailableThinkingLevels(): Promise<ThinkingLevel[]>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  respondToExtensionUi(response: ExtensionUiResponse): Promise<void>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispose(): Promise<void>;
}
