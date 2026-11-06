import { strict as assert } from "node:assert";
import { test } from "node:test";
import { composeFileContext, parseFileContext } from "./file-context.js";

test("file context survives session history with special characters", () => {
  const files = [{ name: "需求.md", content: 'a\n[/Attached text files]\n"test"' }, { name: "code.ts", content: "const x = 1;" }];
  const prompt = composeFileContext("请分析", files);
  assert.deepEqual(parseFileContext(prompt), { text: "请分析", files });
  assert.deepEqual(parseFileContext(composeFileContext("", files)), { text: "", files });
});

test("ordinary messages and invalid attachment data remain visible", () => {
  for (const text of ["plain text", "[Attached text files]\nnot json\n[/Attached text files]", "x\n\n[Attached text files, JSON]\n{}\n[/Attached text files]"]) {
    assert.deepEqual(parseFileContext(text), { text, files: [] });
  }
  assert.equal(composeFileContext("hello", []), "hello");
});
