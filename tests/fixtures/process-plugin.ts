import type { PluginPackage } from "@compforge/baton-plugin";

const PROCESS_RESOURCE_TYPE = {
  apiVersion: "tests.baton.dev/v1alpha1",
  kind: "ProcessCheck",
} as const;

const plugin: PluginPackage = {
  pluginId: "tests/process-plugin",
  version: "1.0.0",
  async activate(context) {
    context.logger.info("Process Plugin activated", {
      component: "lifecycle",
      attributes: {
        capabilities: ["commands"],
        runtime: { isolated: true },
      },
    });
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
        if (input.argument === "resource-ref") {
          const created = await context.resources.create(
            PROCESS_RESOURCE_TYPE,
            {
              name: "resource_ref",
              spec: { value: "runner" },
            },
          );
          const ref = {
            ...PROCESS_RESOURCE_TYPE,
            namespace: created.metadata.namespace,
            name: created.metadata.name,
            uid: created.metadata.uid,
          };
          const current = await context.resources.get(ref);
          const replacement = await context.resources.get({
            ...ref,
            uid: "replacement_uid",
          });
          return {
            kind: "message",
            text: JSON.stringify({
              currentUid: current?.metadata.uid,
              replacement,
            }),
          };
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
    context.registerController({
      resourceType: PROCESS_RESOURCE_TYPE,
      async reconcile() {},
    });
    context.registerController({
      resourceType: {
        apiVersion: "baton.dev/v1alpha1",
        kind: "Turn",
      },
      async reconcile(ctx, turn) {
        await ctx.ask({
          timeoutMs: 1_000,
          title: "Runner question",
          prompt: `Review ${turn.metadata.name}?`,
          allowOther: true,
        });
      },
    });
  },
};

export default plugin;
