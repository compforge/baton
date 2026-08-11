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

Use `get(ref)` to read a Resource. Omit `uid` for a name-based lookup that may
resolve the current incarnation. Include `uid` when continuing work from an
earlier observation, especially after awaiting a Core verb:

```ts
const current = await context.resources.get({
  ...EXAMPLE_RESOURCE,
  namespace: resource.metadata.namespace,
  name: resource.metadata.name,
  uid: resource.metadata.uid,
});
if (!current) return; // Deleted or replaced while this continuation waited.
```

`get(ref)` returns `undefined` when the name is absent or its `uid` no longer
matches. Omitting `uid` intentionally performs a name-based lookup that may
resolve a replacement. Namespace isolation is still enforced.

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
`ctx.snapshot`, and can await a typed user decision directly:

```ts
const decision = await ctx.ask({
  title: "Associate pull request",
  prompt: "Which requirement should own this pull request?",
  timeoutMs: 10 * 60_000,
  choices: [
    { value: "req_1", label: "REQ-1" },
    { value: "standalone", label: "Do not associate" },
  ],
});
if (decision.state !== "success") {
  // dismissed, timeout, or failure: apply the domain's fallback policy.
  return;
}
await associate(decision.value);
```

A command can return `search.mode: "local"` to let chat-tui filter its current
options, or `"remote"` to receive later query text in
`PluginCommandInput.searchQuery`. Baton debounces remote queries and ignores
responses superseded by a newer query. A remote result may contain no options;
return the same remote-search picker shape so the field stays open.

The Promise stays pending until the user answers, dismisses the Interaction, or
the required timeout expires. Baton preserves the current async continuation,
but releases both the Controller concurrency slot and the Manager-wide slot
while it waits, so other Resources can reconcile. The result is persisted before
the original continuation resumes; Baton does not re-enqueue the Resource to
deliver the answer.

Every verb returns the same closed outer outcome:

```ts
type VerbResult<T> =
  | { state: "success"; value: T }
  | { state: "dismissed" }
  | { state: "timeout" }
  | { state: "failure"; error?: string };
```

`dismissed` means the user saw the Interaction and pressed Esc or closed it. A
deliberate negative answer, such as declining a confirmation, is a successful
business value. The Plugin decides how each non-success outcome degrades.

`ReconcileContext` methods are typed Core verbs rather than generic messages.
Every verb first materializes a Core-owned Interaction. `draft` continues only
after its suggested input is submitted; `harness` continues only after its
mandatory gate is approved. A host policy may auto-approve that gate, but Baton
still persists the requested and answered Interaction facts before creating a
HarnessInvocation. Plugins cannot select a topic, provide a routing callback,
or pass a Harness-native DTO through Core.

Each choice `value` is the stable answer value persisted by Baton and returned
as `decision.value`; `label` and `description` are presentation only. A closed
choice ask preserves the literal union of those values. Setting
`allowOther: true` permits arbitrary non-empty text and therefore widens the
answer type to `string`; omit `choices` and set `allowOther: true` for a pure
free-text ask.

Baton gives each live reconcile a Core-issued Plugin execution identity. Verb
continuation is correlated with that execution, not with the triggering
Resource and not with a caller-provided operation key. Resource deletion does
not implicitly dismiss an Interaction. If the Runner or Core crashes, the
in-memory continuation is not replayed and its unfinished verb becomes
`failure`.

A Controller uses `ctx.draft` to let the user edit a prompt, or `ctx.harness`
to request a driven Turn with a ready prompt. Both pass through Interaction;
only an approved/submitted result creates the HarnessInvocation. The Plugin
explicitly declares the Lane for execution:

- `laneId` names an existing Lane to continue. `main` is the reserved main Lane ID.
- `newLane: true` allocates a new asynchronous Lane from `laneId`; omitted or
  `false` continues that Lane.

Baton owns target selection, admission, execution, cancellation, ledger and
recovery. Lane is a Baton-native task line rather than a Plugin-private
execution type:

An explicit `draft.harnessTargetId` fixes the Target and is shown with the
editable draft. When omitted, Baton resolves the host's current selection when
the user submits the draft and persists that final Target before scheduling.
An omitted `harness.harnessTargetId` is resolved immediately because direct
execution has no editing phase.

```ts
const execution = await ctx.harness({
  title: "Implement",
  prompt: "Implement the example and run its focused tests.",
  timeoutMs: 30 * 60_000,
  laneId: "main",
  newLane: true,
});
if (execution.state !== "success") return;
if (execution.value.outcome === "declined") return;
// Inspect execution.value.turn.stopReason and update Resource status.
```

The successful result's `laneId` is the actual execution Lane and can be passed
to a later call to continue the same side task. `completed` means the Turn
closed, not that domain acceptance succeeded. A manual gate rejection returns
`{ state: "success", value: { outcome: "declined" } }`. Closing a draft or
pressing Esc returns `dismissed` and creates no HarnessInvocation when the gate
has not passed. Dispatch errors and process interruption return `failure`.

`timeoutMs` is mandatory on `ask`, `confirm`, `draft`, and `harness`. For an
action verb, one deadline covers its Interaction gate, admission, and final
Turn; approval does not reset the clock. Its value must be an integer between
`1` and `MAX_VERB_TIMEOUT_MS` (2,147,483,647 milliseconds).
