import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function compatibilityExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("harness-compat", "Extension loaded");
    ctx.ui.notify("Harness compatibility extension loaded", "info");
  });

  pi.registerCommand("harness-ui", {
    description: "Exercise every dialog supported by the Harness RPC UI bridge",
    handler: async (_args, ctx) => {
      const confirmed = await ctx.ui.confirm("Harness confirm", "Confirm compatibility test?");
      if (!confirmed) return;
      const selected = await ctx.ui.select("Harness select", ["Alpha", "Beta"]);
      const input = await ctx.ui.input("Harness input", "type a value");
      const edited = await ctx.ui.editor("Harness editor", "Line 1\nLine 2");
      ctx.ui.setStatus("harness-compat", `Done: ${selected}/${input}`);
      ctx.ui.notify(`Compatibility complete (${edited?.split("\n").length ?? 0} lines)`, "info");
    },
  });

  pi.registerCommand("harness-ui-cancel", {
    description: "Verify that a cancelled RPC dialog returns control to the extension",
    handler: async (_args, ctx) => {
      const value = await ctx.ui.input("Cancel this dialog", "cancel me");
      ctx.ui.notify(value === undefined ? "Cancellation received" : "Unexpected value", value === undefined ? "info" : "error");
    },
  });
}
