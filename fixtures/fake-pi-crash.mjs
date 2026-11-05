#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "get_state") {
      process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: "get_state", success: true, data: {
        sessionId: "fake-crash", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0,
      } })}\n`);
    } else if (command.type === "prompt") {
      setTimeout(() => process.exit(42), 20);
    } else {
      process.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true })}\n`);
    }
  }
});
