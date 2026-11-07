import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiRpcAdapter } from "./pi-rpc-adapter.js";

test("resume uses a saved path and falls back to ID discovery when it is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-resume-"));
  const fake = join(root, "pi.mjs");
  await writeFile(fake, `import readline from 'node:readline';
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const command = JSON.parse(line);
      console.log(JSON.stringify({id:command.id,type:'response',success:true,data:{sessionId:'test',args:process.argv.slice(2)}}));
    }`);
  const sessionFile = join(root, "saved session.jsonl");
  await writeFile(sessionFile, "");
  try {
    for (const exists of [true, false]) {
      if (!exists) await rm(sessionFile);
      const adapter = new PiRpcAdapter({ harnessSessionId: "test", piSessionId: "test", piSessionFile: sessionFile, projectDir: root, sessionDir: root, piPath: process.execPath, piExecutableArgs: [fake] });
      try {
        const state = await adapter.start() as unknown as { args: string[] };
        assert.deepEqual(state.args.slice(0, 4), ["--mode", "rpc", exists ? "--session" : "--session-id", exists ? sessionFile : "test"]);
      } finally { await adapter.dispose(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
