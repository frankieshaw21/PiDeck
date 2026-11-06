import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cjkStrong } from "./cjk-strong.js";

test("renders bold markers next to Chinese text without changing code", () => {
  const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "**本次仅读取。**整体上" }, { type: "inlineCode", value: "**原样**" }] }] };
  cjkStrong()(tree);
  assert.deepEqual(tree.children[0]?.children, [
    { type: "strong", children: [{ type: "text", value: "本次仅读取。" }] },
    { type: "text", value: "整体上" },
    { type: "inlineCode", value: "**原样**" },
  ]);
});
