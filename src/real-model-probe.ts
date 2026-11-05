import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRpcAdapter } from "./runtime/pi-rpc-adapter.js";
import type { RuntimeEvent } from "./runtime/types.js";

const root = await mkdtemp(join(tmpdir(), "minimal-pi-real-"));
const common = {
  projectDir: process.cwd(),
  sessionDir: join(root, "sessions"),
  piPath: process.env.PI_PATH ?? "pi",
  extraArgs: ["--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files"],
};
const a = new PiRpcAdapter({ ...common, harnessSessionId: "probe-a", piSessionId: "real-probe-a" });
const b = new PiRpcAdapter({ ...common, harnessSessionId: "probe-b", piSessionId: "real-probe-b" });
let restoredB: PiRpcAdapter | undefined;

function settled(adapter: PiRpcAdapter, events: RuntimeEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for agent_settled"));
    }, 120_000);
    const unsubscribe = adapter.subscribe((event) => {
      events.push(event);
      if (event.record.type === "agent_settled") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

const eventsA: RuntimeEvent[] = [];
const eventsB: RuntimeEvent[] = [];
try {
  const [stateA, stateB] = await Promise.all([a.start(), b.start()]);
  assert.notEqual(stateA.sessionId, stateB.sessionId);

  const settledA = settled(a, eventsA);
  const settledB = settled(b, eventsB);
  const runA = await a.prompt("Write a detailed 1500-word explanation of why deterministic event routing matters in concurrent systems. Do not use tools.");
  const runB = await b.prompt("Reply with exactly: SESSION_B_OK");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await a.abort();
  await Promise.all([settledA, settledB]);

  const messagesB = await b.getMessages();
  const serializedB = JSON.stringify(messagesB);
  const textUpdatesA = eventsA.filter((event) => event.record.type === "message_update").length;
  const textUpdatesB = eventsB.filter((event) => event.record.type === "message_update").length;
  assert.ok(eventsA.every((event) => event.harnessSessionId === "probe-a"));
  assert.ok(eventsB.every((event) => event.harnessSessionId === "probe-b"));
  assert.ok(eventsA.filter((event) => event.runId).every((event) => event.runId === runA.runId));
  assert.ok(eventsB.filter((event) => event.runId).every((event) => event.runId === runB.runId));
  assert.match(serializedB, /SESSION_B_OK/);

  await b.dispose();
  restoredB = new PiRpcAdapter({ ...common, harnessSessionId: "probe-b-restored", piSessionId: "real-probe-b" });
  await restoredB.start();
  const restoredMessagesB = JSON.stringify(await restoredB.getMessages());
  assert.match(restoredMessagesB, /SESSION_B_OK/);

  console.log(JSON.stringify({
    model: stateA.model ? `${stateA.model.provider}/${stateA.model.id}` : null,
    sessionA: { disposition: runA.disposition, textUpdates: textUpdatesA, abortedAndSettled: true },
    sessionB: { disposition: runB.disposition, textUpdates: textUpdatesB, completed: serializedB.includes("SESSION_B_OK"), restored: true },
    eventIsolation: true,
  }, null, 2));
} finally {
  await Promise.allSettled([a.dispose(), b.dispose(), restoredB?.dispose()]);
  await rm(root, { recursive: true, force: true });
}
