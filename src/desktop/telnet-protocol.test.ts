import assert from "node:assert/strict";
import { test } from "node:test";
import { TelnetProtocol } from "./telnet-protocol.js";

test("negotiation and escaped data remain correct across packet boundaries", () => {
  const parser = new TelnetProtocol();
  const chunks = [Buffer.from([65, 255]), Buffer.from([251]), Buffer.from([1, 66, 255, 255, 67, 255, 250, 24]), Buffer.from([1, 255]), Buffer.from([240, 68, 255, 253, 3])];
  const results = chunks.map((chunk) => parser.read(chunk));
  assert.deepEqual(Buffer.concat(results.map((result) => result.data)), Buffer.from([65, 66, 255, 67, 68]));
  assert.deepEqual(Buffer.concat(results.map((result) => result.reply)), Buffer.from([255, 254, 1, 255, 252, 3]));
});
