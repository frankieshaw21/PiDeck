export type TaskIntent = "analysis" | "write";
export type ExecutionState = "Idle" | "Queued" | "Running" | "WaitingForUser" | "Stopping" | "Failed";

export interface ExecutionRequest {
  sessionId: string;
  projectDir: string;
  intent: TaskIntent;
}

export interface ExecutionLease {
  taskId: string;
  release(): void;
}

interface QueueEntry extends ExecutionRequest {
  taskId: string;
  resolve: (lease: ExecutionLease) => void;
  reject: (error: Error) => void;
}

export interface ExecutionControllerOptions {
  maxConcurrent: number;
  onStateChange?: (sessionId: string, state: ExecutionState) => void;
}

export class ExecutionController {
  readonly #maxConcurrent: number;
  readonly #onStateChange: ((sessionId: string, state: ExecutionState) => void) | undefined;
  readonly #queue: QueueEntry[] = [];
  readonly #active = new Map<string, ExecutionRequest & { taskId: string }>();
  #counter = 0;

  constructor(options: ExecutionControllerOptions) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    this.#maxConcurrent = options.maxConcurrent;
    this.#onStateChange = options.onStateChange;
  }

  acquire(request: ExecutionRequest): Promise<ExecutionLease> {
    if (this.has(request.sessionId)) throw new Error(`Session ${request.sessionId} already has a task`);
    const taskId = `task-${++this.#counter}`;
    return new Promise((resolve, reject) => {
      this.#queue.push({ ...request, taskId, resolve, reject });
      this.#state(request.sessionId, "Queued");
      this.#drain();
    });
  }

  has(sessionId: string): boolean {
    return this.#active.has(sessionId) || this.#queue.some((entry) => entry.sessionId === sessionId);
  }

  isQueued(sessionId: string): boolean {
    return this.#queue.some((entry) => entry.sessionId === sessionId);
  }

  isActive(sessionId: string): boolean {
    return this.#active.has(sessionId);
  }

  cancelQueued(sessionId: string): boolean {
    const index = this.#queue.findIndex((entry) => entry.sessionId === sessionId);
    if (index < 0) return false;
    const [entry] = this.#queue.splice(index, 1);
    entry!.reject(new Error("Queued task cancelled"));
    this.#state(sessionId, "Idle");
    this.#drain();
    return true;
  }

  markStopping(sessionId: string): void {
    if (this.#active.has(sessionId)) this.#state(sessionId, "Stopping");
  }

  release(sessionId: string): void {
    if (!this.#active.delete(sessionId)) return;
    this.#state(sessionId, "Idle");
    this.#drain();
  }

  fail(sessionId: string): void {
    const queuedIndex = this.#queue.findIndex((entry) => entry.sessionId === sessionId);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    this.#active.delete(sessionId);
    this.#state(sessionId, "Failed");
    this.#drain();
  }

  snapshot(): { active: string[]; queued: string[] } {
    return { active: [...this.#active.keys()], queued: this.#queue.map((entry) => entry.sessionId) };
  }

  #drain(): void {
    while (this.#active.size < this.#maxConcurrent) {
      const index = this.#queue.findIndex((entry) => this.#eligible(entry));
      if (index < 0) return;
      const [entry] = this.#queue.splice(index, 1);
      if (!entry) return;
      this.#active.set(entry.sessionId, entry);
      this.#state(entry.sessionId, "Running");
      let released = false;
      entry.resolve({
        taskId: entry.taskId,
        release: () => {
          if (released) return;
          released = true;
          this.release(entry.sessionId);
        },
      });
    }
  }

  #eligible(entry: QueueEntry): boolean {
    if (entry.intent !== "write") return true;
    return ![...this.#active.values()].some((active) => active.projectDir === entry.projectDir && active.intent === "write");
  }

  #state(sessionId: string, state: ExecutionState): void {
    this.#onStateChange?.(sessionId, state);
  }
}
