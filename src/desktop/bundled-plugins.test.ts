import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { externalSkillPaths } from "./bundled-plugins.js";

test("external skill manifest is read without hard-coded domain names", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-skill-manifest-"));
  try {
    await mkdir(join(root, "skills"));
    await writeFile(join(root, "package.json"), JSON.stringify({ pi: { skills: ["skills/one/SKILL.md", "../outside/SKILL.md", "/absolute/SKILL.md", 4] } }));
    assert.deepEqual(externalSkillPaths(root), [join(root, "skills/one/SKILL.md")]);
    await writeFile(join(root, "package.json"), "invalid");
    assert.deepEqual(externalSkillPaths(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
