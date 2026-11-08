import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceOutput } from "./device-output.js";
test("renders DEVICE ANSI redraws and backspaces without inserting newlines", () => {
  assert.equal(deviceOutput("\x1b[Jadmin@DEVICE> configure\r\n[edit]\r\nadmin@DEVICE# \b"), "admin@DEVICE> configure\n[edit]\nadmin@DEVICE#");
});
