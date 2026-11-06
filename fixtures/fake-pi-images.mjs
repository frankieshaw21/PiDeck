import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === "prompt") {
    process.stdout.write(JSON.stringify({ type: "image_check", images: command.images, message: command.message }) + "\n");
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { disposition: "handled" } }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: { sessionId: "image-test", isStreaming: false, isCompacting: false, messageCount: 0, pendingMessageCount: 0 } }) + "\n");
  }
}
