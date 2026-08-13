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
    context.commands.register({
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
    context.hooks.register({
      hookId: "process-input",
      stage: "human.inbound.before",
      async run(hook) {
        context.logger.info("Process Hook observed input", {
          component: "hook",
          attributes: { intentId: hook.subject.intentId },
        });
        if (hook.subject.text !== "ask from hook") return;
        await hook.verbs.ask({
          timeoutMs: 1_000,
          title: "Hook question",
          prompt: "Continue from Hook?",
          allowOther: true,
        });
      },
    });
    context.controllers.register({
      resourceType: PROCESS_RESOURCE_TYPE,
      async reconcile() {},
    });
    context.controllers.register({
      resourceType: {
        apiVersion: "baton.dev/v1alpha1",
        kind: "Turn",
      },
      async reconcile(ctx, turn) {
        await ctx.verbs.ask({
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
