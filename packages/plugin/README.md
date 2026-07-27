<p align="center">
  <img src="https://raw.githubusercontent.com/qiankunli/baton/main/docs/assets/baton-icon.png" alt="baton icon" width="112" />
</p>

<h1 align="center">@qiankun01/baton-plugin</h1>

Public, host-independent authoring contract for Baton plugins.

```ts
import {
  type ConditionedStatus,
  type Resource as ExampleResource,
  type PluginActivationContext,
  type PluginPackage,
} from "@qiankun01/baton-plugin";

const EXAMPLE_RESOURCE = {
  apiVersion: "example.baton.dev/v1alpha1",
  kind: "Example",
} as const;

// Creation may attach Plugin-defined string metadata:
// context.resources.create(EXAMPLE_RESOURCE, {
//   name: "example-1",
//   labels: { "example.com/team": "platform" },
//   annotations: { "example.com/display-name": "First example" },
//   spec: { title: "Hello" },
// });

interface ExampleStatus extends ConditionedStatus {
  readonly phase?: "active" | "done";
}

type Example = ExampleResource<{ title: string }, ExampleStatus>;

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
          search: {
            mode: "remote",
            query: "",
            placeholder: "Search examples",
          },
          options: [{ name: "Hello", value: "hello" }],
        };
      },
    });
    context.registerContextProvider({
      kind: "example",
      search(query) {
        return context.resources
          .list<{ title: string }, ExampleStatus>(
            EXAMPLE_RESOURCE,
          )
          .filter((resource) =>
            resource.spec.title.toLowerCase().includes(query.toLowerCase())
          )
          .map((resource) => ({
            id: resource.metadata.name,
            label: resource.spec.title,
            detail: resource.status.phase,
          }));
      },
      provide(id, { maxChars }) {
        const resource = context.resources.get<
          { title: string },
          ExampleStatus
        >(EXAMPLE_RESOURCE, id);
        return `Example: ${resource.spec.title}`.slice(0, maxChars);
      },
    });
    context.registerController({
      resourceType: EXAMPLE_RESOURCE,
      sources: [{
        type: "cron",
        sourceId: "periodic-refresh",
        cron: "*/5 * * * *",
        timeZone: "UTC",
      }],
      async reconcile(_baton, resource: Example) {
        // Observe current facts and patch status through context.resources.
      },
      present(resource) {
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

Plugins may opt into Kubernetes-style current-state conditions by extending
`ConditionedStatus`. `conditions` remains optional and lives inside the
Plugin-owned status schema; Baton stores it but does not interpret condition
types, reasons, transitions, or lifecycle policy. Keep at most one current
condition per `type`, and update `lastTransitionTime` only when that condition's
`status` changes.

`context.toast` is session-scoped and non-durable. Use it for one-off feedback
caused by an operation or state transition. Ongoing state belongs in Resource
status and an optional Board presentation; do not emit a toast on every reconcile.

`registerContextProvider` exposes searchable, read-only context that a user can
explicitly add to one Harness turn with `@`. `kind` is local to the Package;
Baton qualifies it as `<pluginName>@<kind>`, groups picker candidates by that
identity, and removes the registration with the Plugin Binding. Keep `search`
local and side-effect free; `provide` runs only after the user selects a
reference and submits the turn.

Controller cron Sources are recurring wakeups. When a cron expression is due,
Baton first runs the Source's optional `discover` hook, then enqueues every
current Resource of that Controller through the same keyed reconcile queue used
by Resource changes and `requeueAfterMs`. Discovery may create missing
same-kind Resources; status changes and outputs still belong exclusively to
`reconcile`.

A Controller can return `kind: "interaction"` when its Resource needs a durable
user decision:

```ts
return {
  output: {
    kind: "interaction",
    decisionKey: "associate-pr",
    title: "Associate pull request",
    prompt: "Which requirement should own this pull request?",
    options: [
      { optionId: "req_1", label: "REQ-1" },
      { optionId: "reject", label: "Do not associate", role: "reject" },
    ],
  },
};
```

A command can return `search.mode: "local"` to let chat-tui filter its current
options, or `"remote"` to receive later query text in
`PluginCommandInput.searchQuery`. Baton debounces remote queries and ignores
responses superseded by a newer query. A remote result may contain no options;
return the same remote-search picker shape so the field stays open.

On the next reconcile, read the result from
`baton.pluginInteractions` by `decisionKey`. Baton persists the answer before
re-enqueuing the same Resource, so plugins do not register option callbacks or
hold an in-memory promise while waiting. Omit `options` for free text.
