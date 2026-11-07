import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DeviceProfileStore } from "./device-profiles.js";

test("profiles persist without credentials and remain isolated by conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pideck-profiles-"));
  try {
    const path = join(root, "profiles.json");
    const store = new DeviceProfileStore(path);
    await store.load();
    const first = await store.save("a", { name: "switch", protocol: "ssh", host: "switch.local", port: 22, username: "admin", password: "secret" } as never);
    await store.save("a", { name: "router", protocol: "telnet", host: "192.0.2.1", port: 23, username: "admin" });
    await store.save("b", { name: "server", protocol: "ssh", host: "server.local", port: 22, username: "admin" });
    assert.doesNotMatch(await readFile(path, "utf8"), /secret|password/);
    const restored = new DeviceProfileStore(path); await restored.load();
    assert.equal(restored.list("a").length, 2);
    assert.equal(restored.list("b").length, 1);
    await assert.rejects(restored.save("b", { ...first, name: "stolen" }), /another conversation/);
    await restored.remove("a", first.id);
    assert.equal(restored.list("a").length, 1);
    assert.equal(restored.list("b").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
