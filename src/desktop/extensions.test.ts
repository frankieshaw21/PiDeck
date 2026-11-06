import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ExtensionStore } from "./extensions.js";
import { HarnessSessionManager } from "../core/session-manager.js";

test("persists extension settings and loads enabled entries into new Pi sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-extensions-"));
  const store = new ExtensionStore(join(root, "extensions.json"));
  const manager = new HarnessSessionManager({ storageDir: join(root, "sessions"), piPath: process.env.PI_PATH ?? "pi", extensionPaths: () => store.enabledPaths() });
  try {
    await store.load();
    await store.add(resolve("fixtures/extensions/compatibility.ts"));
    await assert.rejects(store.add(resolve("fixtures/extensions/compatibility.ts")), /already added/);
    await manager.load();
    const session = await manager.create(process.cwd());
    assert.ok((await manager.runtime(session.metadata.id)!.getCommands()).some((command) => command.name === "harness-ui"));
    const path = store.list()[0]!.path;
    await store.setEnabled(path, false);
    const another = await manager.create(process.cwd());
    assert.ok(!(await manager.runtime(another.metadata.id)!.getCommands()).some((command) => command.name === "harness-ui"));
    const restored = new ExtensionStore(join(root, "extensions.json"));
    await restored.load();
    assert.equal(restored.list()[0]?.enabled, false);
    await restored.remove(path);
    assert.equal(restored.list().length, 0);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("accepts a local extension folder and rejects manifest paths outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-extension-folder-"));
  try {
    const folder = join(root, "extension"); await mkdir(folder);
    await writeFile(join(folder, "index.ts"), "export default () => {};");
    const store = new ExtensionStore(join(root, "index.json"));
    await store.add(folder);
    assert.deepEqual(store.enabledPaths(), [await realpath(join(folder, "index.ts"))]);
    const bad = join(root, "bad"); await mkdir(bad);
    await writeFile(join(bad, "package.json"), JSON.stringify({ pi: { extensions: ["../extension/index.ts"] } }));
    await assert.rejects(store.add(bad), /inside its directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("validates network sources and rejects local or credential-bearing URLs", async () => {
  const { networkPackagePath } = await import("./extensions.js");
  assert.equal(networkPackagePath("npm:@example/tools@1.2.3"), join("npm", "node_modules", "@example/tools"));
  assert.equal(networkPackagePath("git:github.com/example/tools@v1"), join("git", "github.com", "example/tools"));
  assert.equal(networkPackagePath("https://github.com/example/tools.git"), join("git", "github.com", "example/tools"));
  for (const input of ["npm:../../x", "file:///tmp/extension", "https://user:secret@example.com/a/b", "https://example.com/a/%2e%2e/b"]) assert.throws(() => networkPackagePath(input));
});

test("network install uses isolated Pi storage and loads the resulting package", { skip: process.platform === "win32" }, async () => {
  const { chmod } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "harness-network-test-"));
  const store = new ExtensionStore(join(root, "extensions.json"));
  const script = join(root, "fake-pi");
  const manager = new HarnessSessionManager({ storageDir: join(root, "sessions"), piPath: process.env.PI_PATH ?? "pi", extensionPaths: () => store.enabledPaths() });
  try {
    await writeFile(script, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const root = path.join(process.env.PI_CODING_AGENT_DIR, 'npm/node_modules/test-package'); fs.mkdirSync(root, {recursive:true}); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({pi:{extensions:['./index.js']}})); fs.writeFileSync(path.join(root, 'index.js'), "export default function(pi) { pi.registerCommand('network-test', { handler: async () => {} }); }");\n`);
    await chmod(script, 0o755);
    await store.addNetwork("npm:test-package@1.0.0", script);
    await manager.load();
    const session = await manager.create(process.cwd());
    assert.ok((await manager.runtime(session.metadata.id)!.getCommands()).some((command) => command.name === "network-test"));
    await store.remove("npm:test-package@1.0.0");
    assert.equal(store.list().length, 0);
  } finally { await manager.dispose(); await rm(root, { recursive: true, force: true }); }
});
