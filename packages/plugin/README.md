<p align="center">
  <img src="https://raw.githubusercontent.com/qiankunli/baton/main/docs/assets/baton-icon.png" alt="baton icon" width="112" />
</p>

<h1 align="center">@qiankun01/baton-plugin</h1>

Public, host-independent authoring contract for Baton plugins.

```ts
import {
  type Resource as ExampleResource,
  type PluginActivationContext,
  type PluginPackage,
} from "@qiankun01/baton-plugin";

type Example = ExampleResource<
  { title: string },
  { phase?: "active" | "done" }
>;

const plugin: PluginPackage = {
  pluginId: "example/plugin",
  version: "0.1.0",
  activate(context: PluginActivationContext) {
    context.toast.show({ text: "Example plugin ready", tone: "success" });
    context.registerCommand({
      commandId: "examples",
      name: "examples",
      description: "List examples",
      execute() {
        return {
          kind: "picker",
          title: "Examples",
          options: [{ name: "Hello", value: "hello" }],
        };
      },
    });
    context.registerController({
      resourceKind: "Example",
      sources: [{
        type: "cron",
        sourceId: "periodic-refresh",
        cron: "*/5 * * * *",
        timeZone: "UTC",
      }],
      async reconcile(_baton, resource: Example) {
        // Observe current facts and patch status through context.resources.
      },
      print(resource) {
        return {
          title: resource.spec.title,
          status: resource.status.phase,
        };
      },
    });
  },
};

export default plugin;
```

This package contains protocol types only. Baton runtime implementations such
as Manager, Binding, Controller, Store, Marketplace, persistence, and Harness
routing are intentionally excluded.

`context.toast` is session-scoped and non-durable. Use it for one-off feedback
caused by an operation or state transition. Ongoing state belongs in Resource
status and an optional Board projection; do not emit a toast on every reconcile.

Controller cron Sources are recurring wakeups. When a cron expression is due,
Baton enqueues every current Resource of that Controller through the same keyed
reconcile queue used by Resource changes and `requeueAfterMs`. Sources never run
a separate callback or mutate Resource status directly.
