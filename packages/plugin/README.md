<p align="center">
  <img src="https://raw.githubusercontent.com/qiankunli/baton/main/docs/assets/baton-icon.png" alt="baton icon" width="112" />
</p>

<h1 align="center">@compforge/baton-plugin</h1>

Public, host-independent authoring contract for Baton plugins.

```ts
import {
  type ConditionedStatus,
  type Resource as ExampleResource,
  type PluginActivationContext,
  type PluginPackage,
} from "@compforge/baton-plugin";

const EXAMPLE_RESOURCE = {
  apiVersion: "example.baton.dev/v1alpha1",
  kind: "Example",
  shortNames: ["ex"],
} as const;

// Creation may attach Plugin-defined string metadata:
// await context.resources.create(EXAMPLE_RESOURCE, {
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
  async activate(context: PluginActivationContext) {
    context.logger.info("Example plugin activated", {
      component: "activation",
      attributes: { resourceTypes: [EXAMPLE_RESOURCE.kind] },
    });
    context.toast.show({ text: "Example plugin ready", tone: "success" });
    context.registerCommand({
      commandId: "examples",
      name: "examples",
      description: "List examples",
      async execute() {
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
      async search(query) {
        const resources = await context.resources.list<
          { title: string },
          ExampleStatus
        >(EXAMPLE_RESOURCE);
        return resources
          .filter((resource) =>
            resource.spec.title.toLowerCase().includes(query.toLowerCase())
          )
          .map((resource) => ({
            id: resource.metadata.name,
            label: resource.spec.title,
            detail: resource.status.phase,
          }));
      },
      async provide(id, { maxChars }) {
        const resource = await context.resources.get<
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
      async reconcile(_ctx, resource: Example) {
        // Observe current facts and patch status through context.resources.
      },
      async present(resource) {
        return {
          title: resource.spec.title,
          url: resource.status.url,
          status: resource.status.phase,
          priority: resource.status.phase === "blocked" ? 100 : 0,
        };
      },
    });
  },
};

export default plugin;
```

This package contains protocol types only. Baton host implementations such as
Manager, Binding, Supervisor, Runner, Controller, Store, Marketplace,
persistence, and Harness routing are intentionally excluded.

`present()` may return a finite numeric `priority`; higher values are shown
first and omitted values default to `0`. Baton compares priority only within the
same Plugin instance and Resource type, then shows at most five items from that
group. Returning `undefined` still hides the Resource from the Board entirely.
When `url` is present, compatible terminal UIs render the title as a native
hyperlink that users can open with their terminal's link-click gesture.
Detail overflow is handled consistently by the UI rather than configured by
individual Plugins.

Plugins may opt into Kubernetes-style current-state conditions by extending
`ConditionedStatus`. `conditions` remains optional and lives inside the
Plugin-owned status schema; Baton stores it but does not interpret condition
types, reasons, transitions, or lifecycle policy. Keep at most one current
condition per `type`, and update `lastTransitionTime` only when that condition's
`status` changes.

`context.toast` is session-scoped and non-durable. Use it for one-off feedback
caused by an operation or state transition. Ongoing state belongs in Resource
status and an optional Board presentation; do not emit a toast on every reconcile.

`context.logger` writes best-effort diagnostics to the owning BatonSession.
Baton adds the Plugin identity and owns the log path and persistence. Use
`debug/info/warn/error(message, context)` with structured JSON `attributes`
for troubleshooting context. Never include secrets or use diagnostics as
Resource state. Keep lifecycle and aggregate results at `info`, entity details
at `debug`, and deduplicate repeated polling output.

`registerContextProvider` exposes searchable, read-only context that a user can
explicitly add to one Harness turn with `@`. `kind` is local to the Package;
Baton qualifies it as `<pluginName>@<kind>`, groups picker candidates by that
identity, and removes the registration with the Plugin Binding. Keep `search`
local and side-effect free; `provide` runs only after the user selects a
reference and submits the turn.

Controller Sources have two narrow roles:

- A `Source` performs initial discovery, installs live subscriptions,
  and calls `emit(resource)` when it observes a Resource owned by that Controller.
  Baton materializes a missing Resource, treats an identical repeated value as a
  keyed wakeup, and rejects an implicit spec change. `start()` resolves only
  after the initial scan and subscription are ready; the owning Binding aborts
  its signal on close.
- A `CronSource` periodically enqueues every current Resource owned by that
  Controller.

Both paths use the same keyed reconcile queue as Resource changes and
`requeueAfterMs`. Sources never update status or use reconcile capabilities;
those remain exclusively owned by `reconcile`.

Resources may set one `metadata.owner` when they are created or emitted. The
owner must be an existing Resource in the same PluginInstance namespace and
must include its `uid`, so a replacement with the same name does not inherit
dependents. Use this only for structural ownership, not discovery provenance or
domain references.

Labels are constrained, machine-readable selection metadata:

```ts
const openForgeTasks = await context.resources.list(TASK, {
  matchLabels: {
    "example.baton.dev/source": "forge",
    state: "open",
  },
});
```

Every `matchLabels` entry must match exactly. Annotations are opaque string
metadata and are not selectable. Use `patchMetadata()` to update either map by
key; a `null` value removes that key without replacing unrelated entries.

`ResourceClient.delete()` requests deletion. Baton persists
`metadata.deletionTimestamp`, cascades the request to structural descendants,
hides terminating Resources from the Board, and removes each Resource after
its Controller reconciles successfully. A failed terminating reconcile keeps
the Resource durable and uses the normal retry path.

Controllers may also declare `watches` to map changes from secondary Resources
to primary `ReconcileRequest`s:

```ts
import type {
  EventHandler,
  EventResource,
  ReconcileRequest,
} from "@compforge/baton-plugin";

function requests(workspace: EventResource): readonly ReconcileRequest[] {
  const status = workspace.status as {
    readonly repositories?: readonly string[];
  };
  return (status.repositories ?? []).map((name) => ({ name }));
}

const repositories: EventHandler = {
  async create(event) {
    return requests(event.object);
  },
  async update(event) {
    return [...requests(event.oldObject), ...requests(event.newObject)];
  },
  async delete(event) {
    return requests(event.object);
  },
};

registerController({
  resourceType: "Repository",
  watches: [{ resourceType: "Workspace", handler: repositories }],
  async reconcile(_ctx, repository) {
    // Reconcile repository.metadata.name from the latest stored state.
  },
});
```

For an update, map both the old and new Resource so removed relationships still
wake their former owner, then deduplicate the resulting requests. A Watch
routes Resources already stored by Baton; a Source discovers external state
and materializes the primary Resource before it is reconciled.

A Controller receives a `ReconcileContext`, reads current facts from
`ctx.snapshot`, and calls `ctx.ask` when its Resource needs a durable user
decision:

```ts
const decision = await ctx.ask({
  key: "associate-pr",
  title: "Associate pull request",
  prompt: "Which requirement should own this pull request?",
  choices: [
    { value: "req_1", label: "REQ-1" },
    { value: "standalone", label: "Do not associate" },
  ],
});
if (decision.state !== "answered") return;
```

A command can return `search.mode: "local"` to let chat-tui filter its current
options, or `"remote"` to receive later query text in
`PluginCommandInput.searchQuery`. Baton debounces remote queries and ignores
responses superseded by a newer query. A remote result may contain no options;
return the same remote-search picker shape so the field stays open.

The call returns `waiting` until the answer is durable. Baton then re-enqueues
the same Resource, and the same key returns `answered`. Plugins do not register
callbacks or keep a Runner promise alive while waiting.

A Controller uses `ctx.draft` to let the user edit a prompt, or
`ctx.harness` to originate a driven Turn directly. The Plugin explicitly
declares Lane placement for direct execution:

- `lane: "main"` schedules the final Input on the BatonSession main lane.
- `lane: "new"` allocates a new asynchronous lane when the Input is ready to
  run.

Baton owns target selection, admission, execution, cancellation, ledger and
recovery. Lane is a Baton-native task line rather than a Plugin-private
execution type:

```ts
const execution = await ctx.harness({
  key: "implement-v1",
  prompt: "Implement the example and run its focused tests.",
  lane: "new",
});
if (execution.state !== "completed") return;
// Inspect execution.turn.stopReason and update Resource status.
```

The key and parameters are immutable for one logical operation; use a new key
to request another question, draft, or Turn. `completed` means the Turn closed,
not that domain acceptance succeeded.
