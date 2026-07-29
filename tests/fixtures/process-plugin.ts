import type { PluginPackage } from "@compforge/baton-plugin";

const plugin: PluginPackage = {
  pluginId: "tests/process-plugin",
  version: "1.0.0",
  async activate(context) {
    context.registerCommand({
      commandId: "process-check",
      name: "process-check",
      description: "Exercise Plugin Runner process isolation",
      async execute(input) {
        if (input.argument === "data-dirs") {
          return {
            kind: "message",
            text: JSON.stringify(context.dataDirs),
          };
        }
        if (input.argument === "crash") {
          process.exit(17);
        }
        const durationMs = Number.parseInt(input.argument, 10);
        const deadline = Date.now() +
          (Number.isFinite(durationMs) ? durationMs : 200);
        while (Date.now() < deadline) {
          // Deliberately occupy the Runner event loop.
        }
        return {
          kind: "message",
          text: "Runner completed blocking work",
        };
      },
    });
  },
};

export default plugin;
