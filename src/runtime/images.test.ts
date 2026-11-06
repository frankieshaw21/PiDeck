import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { PiRpcAdapter } from "./pi-rpc-adapter.js";
import type { RuntimeEvent } from "./types.js";

test("forwards image attachments to the Pi prompt RPC", async () => {
  const adapter = new PiRpcAdapter({ harnessSessionId: "images", piSessionId: "images", projectDir: process.cwd(), sessionDir: process.cwd(), piPath: process.execPath, piExecutableArgs: [resolve("fixtures/fake-pi-images.mjs")] });
  const events: RuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  try {
    await adapter.start();
    const images = [{ type: "image" as const, mimeType: "image/png" as const, data: "aGVsbG8=" }];
    await adapter.prompt("describe", images);
    const event = events.find((item) => item.record.type === "image_check");
    assert.equal(event?.record.message, "describe");
    assert.deepEqual(event?.record.images, images);
  } finally { await adapter.dispose(); }
});
