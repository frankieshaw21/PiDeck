import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessSessionManager } from "./core/session-manager.js";

const root = await mkdtemp(join(tmpdir(), "minimal-pi-harness-"));
const projectDir = process.cwd();
const manager = new HarnessSessionManager({ storageDir: join(root, "state") });

try {
  await manager.load();
  const first = await manager.create(projectDir, "Probe A");
  const second = await manager.create(projectDir, "Probe B");
  const stateA = await manager.runtime(first.metadata.id)?.getState();
  const stateB = await manager.runtime(second.metadata.id)?.getState();
  console.log(JSON.stringify({
    sessions: manager.list().length,
    distinctHarnessIds: first.metadata.id !== second.metadata.id,
    distinctPiIds: stateA?.sessionId !== stateB?.sessionId,
    bothIdle: stateA?.isStreaming === false && stateB?.isStreaming === false,
  }, null, 2));
} finally {
  await manager.dispose();
  await rm(root, { recursive: true, force: true });
}
