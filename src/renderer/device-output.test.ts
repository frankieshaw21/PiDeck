import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceOutput } from "./device-output.js";
test("renders PICOS ANSI redraws and backspaces without inserting newlines", () => {
  assert.equal(deviceOutput("\x1b[Jadmin@PICOS> configure\r\n[edit]\r\nadmin@PICOS# \b"), "admin@PICOS> configure\n[edit]\nadmin@PICOS#");
});
