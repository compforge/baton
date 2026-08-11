import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ReconcileKey,
  ReconcileScope,
} from "../src/plugin/controller.ts";
import { emptyReconcileSnapshot } from "../src/plugin/reconcile-snapshot.ts";
import { Manager } from "../src/plugin/manager.ts";
import { type Proposal, ProposalStore } from "../src/plugin/proposal.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";
import type { ScheduledHarnessInvocation } from "../src/plugin/harness-invocation.ts";
import { SessionStore } from "../src/store/store.ts";

interface Spec {
  value: string;
}

const roots: string[] = [];
const API_VERSION = "tests.baton.dev/v1alpha1";

function resourceType(kind: string) {
  return { apiVersion: API_VERSION, kind };
}

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-manager-"));
  roots.push(root);
  return root;
}

function scope(pluginInstanceId: string, resourceKind: string = "Requirement"): ReconcileScope {
  return {
    batonSessionId: "bs_test",
    pluginInstanceId,
    resourceApiVersion: API_VERSION,
    resourceKind,
  };
}

function key(
  pluginInstanceId: string,
  resourceId: string,
  resourceKind: string = "Requirement",
): ReconcileKey {
  return {
    ...scope(pluginInstanceId, resourceKind),
    resourceId,
  };
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function store(root: string, pluginInstanceId: string): PluginResourceStore {
  return new PluginResourceStore({
    session: testSession(root),
    pluginInstanceId,
  });
}

function proposalStore(root: string): ProposalStore {
  return new ProposalStore({
    session: testSession(root),
  });
}

function createResource(
  resources: PluginResourceStore,
  resourceKind: string,
  resourceId: string,
): void {
  resources.create<Spec>({
    type: resourceType(resourceKind),
    name: resourceId,
    spec: { value: resourceId },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin Manager", () => {
  test("persists ctx.ask and reconciles its durable answer", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      session,
      pluginInstanceId: "reqloop_default",
    });
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      spec: { value: "run_1" },
    });
    const states: string[] = [];
    const manager = new Manager({
      proposals: new ProposalStore({ session }),
      session,
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.ask({
          key: "associate-pr",
          title: "Associate pull request",
          prompt: "Choose a requirement",
          choices: [
            { value: "req_1", label: "REQ-1" },
            { value: "reject", label: "Do not associate" },
          ],
        });
        states.push(result.state === "answered" ? `${result.state}:${result.value}` : result.state);
      },
    });
    const reconcileKey = {
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };

    await manager.enqueue(reconcileKey);
    const interaction = [...session.loadState().interactions.values()][0]
      ?.interaction;
    expect(interaction?.requester).toEqual({
      type: "plugin",
      pluginInstanceId: "reqloop_default",
    });
    expect(interaction?.kind).toBe("question");
    expect(
      await manager.resolveInteraction(interaction!.interactionId, {
        kind: "question",
        outcome: "answered",
        answers: { decision: ["req_1"] },
      }),
    ).toBe(true);
    await waitFor(() => states.length === 2);
    expect(states).toEqual(["waiting", "answered:req_1"]);
    expect(
      session.loadState().interactions.get(interaction!.interactionId)
        ?.resolution,
    ).toEqual({
      kind: "question",
      outcome: "answered",
      answers: { decision: ["req_1"] },
    });
    await manager.close();
  });

  test("runs ctx.harness on a new lane once and reconciles its result", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      session,
      pluginInstanceId: "reqloop_default",
    });
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      spec: { value: "run_1" },
    });
    const states: string[] = [];
    const scheduled: ScheduledHarnessInvocation[] = [];
    let selectedHarnessTargetId = "claude";
    const manager = new Manager({
      proposals: new ProposalStore({ session }),
      session,
      snapshot() {
        return {
          ...emptyReconcileSnapshot(session.id),
          harnessTargets: [
            { id: "codex", harness: "codex" },
            { id: "claude", harness: "claude" },
          ],
        };
      },
      selectedHarnessTargetId: () => selectedHarnessTargetId,
      enqueueHarnessInvocation(request) {
        scheduled.push(request);
      },
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.harness({
          key: "implement",
          prompt: "Implement run_1.",
          lane: "new",
        });
        states.push(result.state === "pending" ? `${result.state}:${result.phase}` : result.state);
      },
    });
    const reconcileKey = {
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };

    await manager.enqueue(reconcileKey);
    await waitFor(() => scheduled.length === 1);
    expect(scheduled[0]).toMatchObject({
      harnessTargetId: "claude",
      blocks: [{ type: "text", text: "Implement run_1." }],
      source: "plugin",
      lane: "new",
    });
    expect(scheduled[0]?.laneId).not.toBe(session.meta.mainLaneId);
    expect([...session.loadState().interactions.values()]).toEqual([]);
    expect(states).toEqual(["pending:queued"]);
    await manager.start();
    expect(scheduled).toHaveLength(1);
    selectedHarnessTargetId = "codex";

    const input = scheduled[0]!;
    session.append({
      kind: "user_message",
      source: {
        type: "plugin",
        pluginInstanceId: "reqloop_default",
      },
      harness: "claude",
      harnessTargetId: input.harnessTargetId,
      turnId: input.turnId,
      payload: {
        messageId: input.messageId,
        content: [...input.blocks],
      },
    });
    await waitFor(() => states.includes("pending:running"));
    session.append({
      kind: "_baton_turn_summary",
      source: { type: "baton" },
      harness: "claude",
      harnessTargetId: input.harnessTargetId,
      turnId: input.turnId,
      payload: {
        turnId: input.turnId,
        stopReason: "end_turn",
        agentText: "Implemented.",
        toolCalls: [],
      },
    });
    await waitFor(() => states.includes("completed"));
    expect(manager.listHarnessInvocations()[0]).toMatchObject({
      phase: "completed",
      result: { agentText: "Implemented." },
    });
    expect(scheduled).toHaveLength(1);
    await manager.close();
  });

  test("holds ctx.draft until the edited input is submitted", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      session,
      pluginInstanceId: "reqloop_default",
    });
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      spec: { value: "run_1" },
    });
    const scheduled: ScheduledHarnessInvocation[] = [];
    const manager = new Manager({
      proposals: new ProposalStore({ session }),
      session,
      snapshot: () => ({
        ...emptyReconcileSnapshot(session.id),
        harnessTargets: [{ id: "codex", harness: "codex" }],
      }),
      selectedHarnessTargetId: () => "codex",
      enqueueHarnessInvocation(request) {
        scheduled.push(request);
      },
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        await ctx.draft({
          key: "implement",
          prompt: "Implement run_1.",
        });
      },
    });
    await manager.enqueue({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    });
    expect(scheduled).toEqual([]);
    expect(manager.listPendingHarnessInvocationInputs()).toMatchObject([{
      title: "implement",
      prompt: "Implement run_1.",
    }]);

    const invocationId = manager.listPendingHarnessInvocationInputs()[0]!.invocationId;
    expect(manager.resolveHarnessInvocationInput(invocationId, {
      kind: "submitted",
      blocks: [{
        type: "text",
        text: "Implement run_1 with the focused test only.",
      }],
    })).toBe(true);
    await waitFor(() => scheduled.length === 1);
    expect(scheduled[0]).toMatchObject({
      invocationId,
      blocks: [{
        type: "text",
        text: "Implement run_1 with the focused test only.",
      }],
      source: "user",
      lane: "main",
      laneId: session.meta.mainLaneId,
    });
    expect(manager.listPendingHarnessInvocationInputs()).toEqual([]);
    await manager.close();
  });

  test("cancels a pre-admission HarnessInvocation when its Resource incarnation is deleted", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      session,
      pluginInstanceId: "reqloop_default",
    });
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      spec: { value: "run_1" },
    });
    const cancelled: string[] = [];
    const failures: unknown[] = [];
    const manager = new Manager({
      proposals: new ProposalStore({ session }),
      session,
      snapshot: () => ({
        ...emptyReconcileSnapshot(session.id),
        harnessTargets: [{ id: "codex", harness: "codex" }],
      }),
      selectedHarnessTargetId: () => "codex",
      enqueueHarnessInvocation() {},
      cancelHarnessInvocation(requestId) {
        cancelled.push(requestId);
        return "queued";
      },
      onProposal() {},
      onReconcileError(failure) {
        failures.push(failure.error);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx, resource) {
        if (resource.metadata.deletionTimestamp) return;
        await ctx.harness({
          key: "implement",
          prompt: "Implement run_1.",
          lane: "main",
        });
      },
    });
    const reconcileKey = {
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };

    await manager.enqueue(reconcileKey);
    const requestId = manager.listHarnessInvocations()[0]!.invocationId;
    resources.requestDeletion(
      resourceType("Requirement"),
      "run_1",
      new Date("2026-08-10T00:00:00.000Z"),
    );
    await manager.enqueue(reconcileKey);
    await Bun.sleep(20);

    expect(manager.listHarnessInvocations()[0]?.phase).toBe("cancelled");
    expect(cancelled).toEqual([requestId]);
    expect(failures).toEqual([]);
    await manager.close();
  });

  test("routes many Plugin instances through one globally bounded capacity", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "Requirement", "run_1");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const manager = new Manager({
      maxTotalConcurrency: 1,
      proposals: proposalStore(root),
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      async reconcile(_ctx, resource) {
          started.push(resource.metadata.namespace);
          await gate.promise;
          return;
        },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceType: resourceType("Deployment"),
      async reconcile(_ctx, resource) {
          started.push(resource.metadata.namespace);
        },
    });

    const first = manager.enqueue(key("reqloop_default", "run_1"));
    const second = manager.enqueue(key("deploy_default", "deployment_1", "Deployment"));
    await Promise.resolve();
    expect(started).toEqual(["reqloop_default"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["reqloop_default", "deploy_default"]);
  });

  test("rejects duplicate scopes and an unregistered route", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    const definition = {
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {},
    };
    const manager = new Manager({ proposals: proposalStore(root), onProposal() {} });
    manager.registerController(definition);

    expect(() => manager.registerController(definition)).toThrow(
      `plugin Controller already registered for bs_test/reqloop_default/${API_VERSION}/Requirement`,
    );
    await expect(manager.enqueue(key("missing", "run_1"))).rejects.toThrow(
      `no plugin Controller registered for bs_test/missing/${API_VERSION}/Requirement`,
    );
  });

  test("registration close is idempotent and removes only its Controller", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    const manager = new Manager({ proposals: proposalStore(root), onProposal() {} });
    const registration = manager.registerController({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {},
    });

    await expect(manager.enqueue(key("reqloop_default", "run_1"))).resolves.toBeUndefined();
    registration.close();
    registration.close();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      `no plugin Controller registered for bs_test/reqloop_default/${API_VERSION}/Requirement`,
    );
  });

  test("registration close prevents work still waiting for global capacity", async () => {
    const root = testRoot();
    const firstStore = store(root, "reqloop_default");
    const waitingStore = store(root, "deploy_default");
    createResource(firstStore, "Requirement", "run_1");
    createResource(waitingStore, "Deployment", "deployment_1");
    const gate = deferred();
    let waitingRuns = 0;
    const manager = new Manager({
      maxTotalConcurrency: 1,
      proposals: proposalStore(root),
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: firstStore,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          await gate.promise;
        },
    });
    const waitingRegistration = manager.registerController<Spec, Record<string, never>>({
      store: waitingStore,
      resourceType: resourceType("Deployment"),
      async reconcile() {
          waitingRuns += 1;
        },
    });

    const running = manager.enqueue(key("reqloop_default", "run_1"));
    const waiting = manager.enqueue(
      key("deploy_default", "deployment_1", "Deployment"),
    );
    await Promise.resolve();
    waitingRegistration.close();
    const waitingResult = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    gate.resolve();

    await expect(running).resolves.toBeUndefined();
    const waitingError = await waitingResult;
    expect(waitingError).toBeInstanceOf(Error);
    expect((waitingError as Error).message).toBe("plugin Controller is closed");
    expect(waitingRuns).toBe(0);
  });

  test("keeps per-Controller concurrency independent under the global limit", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "Requirement", "run_1");
    createResource(reqloopStore, "Requirement", "run_2");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const manager = new Manager({
      maxTotalConcurrency: 2,
      proposals: proposalStore(root),
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      maxConcurrency: 1,
      async reconcile(_ctx, resource) {
          started.push(
            `${resource.metadata.namespace}/${resource.metadata.name}`,
          );
          await gate.promise;
        },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceType: resourceType("Deployment"),
      maxConcurrency: 1,
      async reconcile(_ctx, resource) {
          started.push(
            `${resource.metadata.namespace}/${resource.metadata.name}`,
          );
          await gate.promise;
        },
    });

    const reqloopFirst = manager.enqueue(key("reqloop_default", "run_1"));
    const reqloopSecond = manager.enqueue(key("reqloop_default", "run_2"));
    const deployment = manager.enqueue(
      key("deploy_default", "deployment_1", "Deployment"),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([
      "reqloop_default/run_1",
      "deploy_default/deployment_1",
    ]);

    gate.resolve();
    await Promise.all([reqloopFirst, reqloopSecond, deployment]);
    expect(started).toEqual([
      "reqloop_default/run_1",
      "deploy_default/deployment_1",
      "reqloop_default/run_2",
    ]);
  });

  test("validates total capacity", () => {
    const root = testRoot();
    expect(
      () =>
        new Manager({
          maxTotalConcurrency: 0,
          proposals: proposalStore(root),
          onProposal() {},
        }),
    ).toThrow(
      "maxTotalConcurrency must be a positive integer",
    );
    expect(
      () =>
        new Manager({
          proposals: proposalStore(root),
          onProposal() {},
          retryBackoff: { initialDelayMs: 0 },
        }),
    ).toThrow("retryBackoff.initialDelayMs must be a positive integer");
    expect(
      () =>
        new Manager({
          proposals: proposalStore(root),
          onProposal() {},
          retryBackoff: { initialDelayMs: 20, maxDelayMs: 10 },
        }),
    ).toThrow("retryBackoff.maxDelayMs must be at least initialDelayMs");
  });

  test("restores pending Proposals on start and can retry a failed projection", async () => {
    const root = testRoot();
    const persisted = proposalStore(root);
    const pending = persisted.record({
      key: key("reqloop_default", "run_1"),
      basedOnGeneration: 1,
      text: "Review requirement",
    });
    let shouldFail = true;
    const surfaced: Proposal[] = [];
    const manager = new Manager({
      proposals: persisted,
      onProposal(proposal) {
        if (shouldFail) throw new Error("view unavailable");
        surfaced.push(proposal);
      },
    });

    await expect(manager.start()).rejects.toThrow("view unavailable");
    shouldFail = false;
    await manager.start();
    await manager.start();

    expect(surfaced).toEqual([pending]);
  });

  test("restores expired and future reconcile times when the Manager starts", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "expired");
    createResource(resources, "Requirement", "future");
    const now = Date.now();
    resources.setNextReconcileAt(resourceType("Requirement"), "expired", new Date(now - 1_000));
    resources.setNextReconcileAt(resourceType("Requirement"), "future", new Date(now + 100));
    const runs: string[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(_ctx, resource) {
          runs.push(resource.metadata.name);
        },
    });

    await manager.start();
    await waitFor(() => runs.includes("expired"));
    expect(runs).toEqual(["expired"]);
    await waitFor(() => runs.includes("future"));
    expect(runs).toEqual(["expired", "future"]);
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toEqual([]);
    registration.close();
  });

  test("turns requeueAfter into another reconcile and replaces the persisted due time", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let runs = 0;
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          runs += 1;
          if (runs === 1) return { requeueAfterMs: 20 };
        },
    });

    await manager.start();
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toHaveLength(1);
    await waitFor(() => runs === 2);
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toEqual([]);
    registration.close();
  });

  test("cron Sources enqueue every current Resource through the keyed queue", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    createResource(resources, "Requirement", "run_2");
    let now = new Date("2026-07-26T00:00:00.990Z");
    const runs: string[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      now: () => now,
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [
        {
          type: "cron",
          sourceId: "poll-pr-state",
          cron: "* * * * * *",
          timeZone: "UTC",
        },
        {
          type: "cron",
          sourceId: "poll-requirement-state",
          cron: "* * * * * *",
          timeZone: "UTC",
        },
      ],
      async reconcile(_ctx, resource) {
          runs.push(resource.metadata.name);
        },
    });

    await manager.start();
    // Controller 启动会先 reconcile 现有 Resource；清空这批结果后再单独观察 cron tick，
    // 避免首次 reconcile 与 timer 同时完成时 runs 从 0 直接越过 2。
    await waitFor(() => runs.length === 2);
    runs.length = 0;
    now = new Date("2026-07-26T00:00:01.000Z");
    await waitFor(() => runs.length === 2);
    expect(runs.sort()).toEqual(["run_1", "run_2"]);
    expect(
      resources.scheduledReconciles(resourceType("Requirement")).length === 0,
    ).toBe(true);

    registration.close();
    await manager.close();
  });

  test("resource Sources finish initial sync before reconciling discovered Resources", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    const ready = deferred();
    const runs: string[] = [];
    const failures: string[] = [];
    let emit!: (resource: { name: string; spec: Spec }) => void;
    let sourceSignal!: { readonly aborted: boolean };
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      onControllerSourceError(failure) {
        failures.push(failure.sourceId);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [{
        type: "resource",
        sourceId: "discover-pr",
        async start(context) {
          emit = context.emit;
          sourceSignal = context.signal;
          context.emit({
            name: "run_discovered",
            spec: { value: "run_discovered" },
          });
          await ready.promise;
        },
      }],
      async reconcile(_ctx, resource) {
        runs.push(resource.metadata.name);
      },
    });

    const starting = manager.start();
    await Bun.sleep(20);
    expect(runs).toEqual([]);
    ready.resolve();
    await starting;
    await waitFor(() => runs.length === 1);
    expect(runs).toEqual(["run_discovered"]);

    emit({
      name: "run_discovered",
      spec: { value: "run_discovered" },
    });
    await waitFor(() => runs.length === 2);
    expect(runs).toEqual(["run_discovered", "run_discovered"]);

    emit({
      name: "run_discovered",
      spec: { value: "different" },
    });
    await waitFor(() => failures.length === 1);
    expect(failures).toEqual(["discover-pr"]);
    expect(resources.get<Spec>(
      resourceType("Requirement"),
      "run_discovered",
    ).spec).toEqual({ value: "run_discovered" });

    registration.close();
    expect(sourceSignal.aborted).toBe(true);
    await manager.close();
  });

  test("resource Source startup failure does not block known Resources", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_known");
    const failures: string[] = [];
    const runs: string[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      onControllerSourceError(failure) {
        failures.push(failure.sourceId);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [{
        type: "resource",
        sourceId: "discover-pr",
        start() {
          throw new Error("forge unavailable");
        },
      }],
      async reconcile(_ctx, resource) {
        runs.push(resource.metadata.name);
      },
    });

    await manager.start();
    expect(failures).toEqual(["discover-pr"]);
    await waitFor(() => runs.length === 1);
    expect(runs).toEqual(["run_known"]);

    registration.close();
    await manager.close();
  });

  test("stops cron Sources when their Controller registration closes", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let now = new Date("2026-07-26T00:00:00.990Z");
    let runs = 0;
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      now: () => now,
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [{
        type: "cron",
        sourceId: "poll-pr-state",
        cron: "* * * * * *",
        timeZone: "UTC",
      }],
      async reconcile() {
          runs += 1;
        },
    });

    await manager.start();
    registration.close();
    now = new Date("2026-07-26T00:00:01.000Z");
    await Bun.sleep(30);
    expect(runs).toBe(1);
    await manager.close();
  });

  test("persists error backoff so another Manager can recover the retry", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    const failures: Array<{ attempt: number; nextRetryAt?: string }> = [];
    const firstManager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      retryBackoff: { initialDelayMs: 30, maxDelayMs: 60 },
      onReconcileError(failure) {
        failures.push({
          attempt: failure.attempt,
          nextRetryAt: failure.nextRetryAt,
        });
      },
    });
    const firstRegistration = firstManager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          throw new Error("connector unavailable");
        },
    });

    await expect(firstManager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "connector unavailable",
    );
    expect(failures).toEqual([{ attempt: 1, nextRetryAt: expect.any(String) }]);
    expect(
      resources.scheduledReconciles(resourceType("Requirement"))[0]
        ?.nextReconcileAt.toISOString(),
    ).toBe(failures[0]?.nextRetryAt);
    firstRegistration.close();

    let recoveredRuns = 0;
    const recoveredManager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const recoveredRegistration = recoveredManager.registerController<
      Spec,
      Record<string, never>
    >({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          recoveredRuns += 1;
        },
    });
    await recoveredManager.start();
    await waitFor(() => recoveredRuns === 1);
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toEqual([]);
    recoveredRegistration.close();
  });

  test("backs off repeated failures per key and resets the attempt after success", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let runs = 0;
    let failNext = false;
    const attempts: number[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      retryBackoff: { initialDelayMs: 10, maxDelayMs: 20 },
      onReconcileError(failure) {
        attempts.push(failure.attempt);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          runs += 1;
          if (runs <= 2 || failNext) {
            failNext = false;
            throw new Error("transient connector failure");
          }
        },
    });

    await manager.start();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "transient connector failure",
    );
    await waitFor(() => runs === 3);
    expect(attempts).toEqual([1, 2]);

    failNext = true;
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "transient connector failure",
    );
    expect(attempts).toEqual([1, 2, 1]);
    await waitFor(() => runs === 5);
    registration.close();
  });

  test("registration close cancels its future reconcile wake-ups", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let runs = 0;
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
        runs += 1;
        return { requeueAfterMs: 50 };
      },
    });

    await manager.start();
    registration.close();
    await Bun.sleep(80);
    expect(runs).toBe(1);
  });
});
