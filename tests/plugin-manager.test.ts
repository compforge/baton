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
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";
import type { ScheduledHarnessInvocation } from "../src/plugin/harness-invocation.ts";
import { MAIN_LANE_ID } from "../src/lane.ts";
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
    namespace: "v1",
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

function instanceStore(root: string): PluginInstanceStore {
  return new PluginInstanceStore({
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
  test("suspends ctx.ask until its durable answer resumes the same reconcile", async () => {
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
      session,
      instances: new PluginInstanceStore({ session }),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.ask({
          timeoutMs: 1_000,
          title: "Associate pull request",
          prompt: "Choose a requirement",
          choices: [
            { value: "req_1", label: "REQ-1" },
            { value: "reject", label: "Do not associate" },
          ],
        });
        states.push(
          result.state === "success"
            ? `${result.state}:${result.value}`
            : result.state,
        );
      },
    });
    const reconcileKey = {
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };

    const reconcile = manager.enqueue(reconcileKey);
    await waitFor(() => session.loadState().interactions.size === 1);
    const interaction = [...session.loadState().interactions.values()][0]
      ?.interaction;
    expect(interaction?.requester).toEqual({
      type: "plugin",
      pluginInstanceId: "reqloop_default",
    });
    expect(interaction?.kind).toBe("question");
    expect(
      await manager.completeInteraction(interaction!.interactionId, {
        kind: "question",
        outcome: "answered",
        answers: { decision: ["req_1"] },
      }),
    ).toBe(true);
    await reconcile;
    expect(states).toEqual(["success:req_1"]);
    expect(
      session.loadState().interactions.get(interaction!.interactionId)
        ?.result,
    ).toEqual({
      kind: "question",
      outcome: "answered",
      answers: { decision: ["req_1"] },
    });
    await manager.close();
  });

  test("returns timeout without re-running the Resource reconcile", async () => {
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
      session,
      instances: new PluginInstanceStore({ session }),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.ask({
          timeoutMs: 30,
          title: "Associate pull request",
          prompt: "Choose a requirement",
          allowOther: true,
        });
        states.push(result.state);
      },
    });

    await manager.enqueue({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    });
    expect(states).toEqual(["timeout"]);
    await manager.close();
  });

  test("returns failure when Core closes a waiting Plugin execution", async () => {
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
      session,
      instances: new PluginInstanceStore({ session }),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.ask({
          title: "Approve",
          prompt: "Continue?",
          timeoutMs: 60_000,
          allowOther: true,
        });
        states.push(
          result.state === "failure"
            ? `${result.state}:${result.error}`
            : result.state,
        );
      },
    });
    const reconcile = manager.enqueue({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    });
    await waitFor(() => session.loadState().interactions.size === 1);

    await manager.close();
    await reconcile;
    expect(states).toEqual(["failure:Plugin Manager was closed"]);
  });

  test("awaits ctx.harness on a new lane and returns its Turn", async () => {
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
      session,
      instances: new PluginInstanceStore({ session }),
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
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.harness({
          title: "Implement",
          prompt: "Implement run_1.",
          timeoutMs: 1_000,
          laneId: "main",
          newLane: true,
        });
        states.push(
          result.state === "success"
            ? `${result.state}:${result.value.outcome}`
            : result.state,
        );
      },
    });
    const reconcileKey = {
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };

    const reconcile = manager.enqueue(reconcileKey);
    await waitFor(() => scheduled.length === 1);
    expect(scheduled[0]).toMatchObject({
      harnessTargetId: "claude",
      blocks: [{ type: "text", text: "Implement run_1." }],
      source: "plugin",
      newLane: true,
      parentLaneId: "main",
    });
    expect(scheduled[0]?.laneId).not.toBe(MAIN_LANE_ID);
    expect([...session.loadState().interactions.values()]).toMatchObject([{
      interaction: {
        kind: "harness_invocation",
        harnessTargetId: "claude",
        laneId: MAIN_LANE_ID,
        newLane: true,
      },
      result: { kind: "harness_invocation", outcome: "approved" },
    }]);
    expect(session.ledger.read().filter((event) =>
      event.kind === "interaction.requested" ||
      event.kind === "interaction.answered" ||
      event.kind === "_baton_harness_invocation_recorded" ||
      event.kind === "_baton_harness_invocation_scheduled"
    ).map((event) => event.kind)).toEqual([
      "interaction.requested",
      "interaction.answered",
      "_baton_harness_invocation_recorded",
      "_baton_harness_invocation_scheduled",
    ]);
    expect(states).toEqual([]);
    selectedHarnessTargetId = "codex";

    const input = scheduled[0]!;
    session.appendEvent({
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
    session.appendEvent({
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
    await reconcile;
    expect(states).toEqual(["success:completed"]);
    expect(manager.listHarnessInvocations()[0]).toMatchObject({
      phase: "completed",
      result: { agentText: "Implemented." },
    });
    expect(scheduled).toHaveLength(1);
    await manager.close();
  });

  test("resolves omitted draft Targets on submission and preserves explicit Targets", async () => {
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
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_2",
      spec: { value: "run_2" },
    });
    const scheduled: ScheduledHarnessInvocation[] = [];
    let selectedHarnessTargetId: string | undefined;
    const manager = new Manager({
      session,
      instances: new PluginInstanceStore({ session }),
      snapshot: () => ({
        ...emptyReconcileSnapshot(session.id),
        harnessTargets: [
          { id: "codex", harness: "codex" },
          { id: "claude", harness: "claude" },
        ],
      }),
      selectedHarnessTargetId: () => selectedHarnessTargetId,
      enqueueHarnessInvocation(request) {
        scheduled.push(request);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx, resource) {
        await ctx.verbs.draft({
          title: "Implement",
          prompt: `Implement ${resource.metadata.name}.`,
          timeoutMs: 1_000,
          ...(resource.metadata.name === "run_2"
            ? { harnessTargetId: "codex" }
            : {}),
        });
      },
    });
    const firstReconcile = manager.enqueue({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    });
    await waitFor(() => session.loadState().interactions.size === 1);
    expect(scheduled).toEqual([]);
    expect(manager.listHarnessInvocations()).toEqual([]);
    const interaction = [...session.loadState().interactions.values()]
      .find(({ interaction: candidate }) =>
        candidate.kind === "suggested_input"
      )?.interaction;
    expect(interaction).toMatchObject({
      kind: "suggested_input",
      title: "Implement",
      text: "Implement run_1.",
    });
    expect(interaction).not.toHaveProperty("harnessTargetId");

    selectedHarnessTargetId = "claude";
    expect(await manager.completeInteraction(interaction!.interactionId, {
      kind: "suggested_input",
      outcome: "submitted",
      blocks: [{
        type: "text",
        text: "Implement run_1 with the focused test only.",
      }],
    })).toBe(true);
    await waitFor(() => scheduled.length === 1);
    const invocationId = scheduled[0]!.invocationId;
    expect(scheduled[0]).toMatchObject({
      invocationId,
      harnessTargetId: "claude",
      blocks: [{
        type: "text",
        text: "Implement run_1 with the focused test only.",
      }],
      source: "user",
      newLane: false,
      laneId: MAIN_LANE_ID,
    });
    const secondReconcile = manager.enqueue({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_2",
    });
    await waitFor(() => session.loadState().interactions.size === 2);
    const fixed = [...session.loadState().interactions.values()]
      .find(({ interaction: candidate }) =>
        candidate.kind === "suggested_input" &&
        candidate.text === "Implement run_2."
      )?.interaction;
    expect(fixed).toMatchObject({
      kind: "suggested_input",
      title: "Implement",
      text: "Implement run_2.",
      harnessTargetId: "codex",
    });
    expect(await manager.completeInteraction(fixed!.interactionId, {
      kind: "suggested_input",
      outcome: "submitted",
      blocks: [{ type: "text", text: "Implement run_2." }],
    })).toBe(true);
    await waitFor(() => scheduled.length === 2);
    expect(scheduled[1]).toMatchObject({
      harnessTargetId: "codex",
    });
    await manager.close();
    await Promise.all([firstReconcile, secondReconcile]);
  });

  test("waits for a manual Interaction gate and never invokes a declined request", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      session,
      pluginInstanceId: "reqloop_default",
    });
    for (const name of ["approve", "decline"]) {
      resources.create<Spec>({
        type: resourceType("Requirement"),
        name,
        spec: { value: name },
      });
    }
    const scheduled: ScheduledHarnessInvocation[] = [];
    const states = new Map<string, string[]>();
    const manager = new Manager({
      session,
      instances: new PluginInstanceStore({ session }),
      snapshot: () => ({
        ...emptyReconcileSnapshot(session.id),
        harnessTargets: [{ id: "codex", harness: "codex" }],
      }),
      selectedHarnessTargetId: () => "codex",
      harnessInvocationGate: () => "require_user",
      enqueueHarnessInvocation(request) {
        scheduled.push(request);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx, resource) {
        const result = await ctx.verbs.harness({
          title: "Implement",
          prompt: `Implement ${resource.metadata.name}.`,
          timeoutMs: 1_000,
          laneId: MAIN_LANE_ID,
        });
        const observed = states.get(resource.metadata.name) ?? [];
        observed.push(
          result.state === "success"
            ? `${result.state}:${result.value.outcome}`
            : result.state,
        );
        states.set(resource.metadata.name, observed);
      },
    });
    const reconcileKey = (resourceId: string) => ({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId,
    });

    const approveReconcile = manager.enqueue(reconcileKey("approve"));
    const declineReconcile = manager.enqueue(reconcileKey("decline"));
    await waitFor(() => session.loadState().interactions.size === 2);
    expect(manager.listHarnessInvocations()).toEqual([]);
    expect(states).toEqual(new Map());
    const interactions = [...session.loadState().interactions.values()]
      .map(({ interaction }) => interaction)
      .filter((interaction) => interaction.kind === "harness_invocation");
    const approved = interactions.find((interaction) =>
      interaction.kind === "harness_invocation" &&
      interaction.prompt === "Implement approve."
    );
    const declined = interactions.find((interaction) =>
      interaction.kind === "harness_invocation" &&
      interaction.prompt === "Implement decline."
    );

    expect(await manager.completeInteraction(approved!.interactionId, {
      kind: "harness_invocation",
      outcome: "approved",
    })).toBe(true);
    expect(await manager.completeInteraction(declined!.interactionId, {
      kind: "harness_invocation",
      outcome: "declined",
    })).toBe(true);
    await waitFor(() => states.get("decline")?.includes("success:declined") === true);
    expect(scheduled).toHaveLength(1);
    expect(manager.listHarnessInvocations()).toHaveLength(1);
    expect(scheduled[0]?.blocks).toEqual([
      { type: "text", text: "Implement approve." },
    ]);
    expect(await manager.cancelHarnessInvocation(scheduled[0]!.invocationId))
      .toBe(true);
    await Promise.all([approveReconcile, declineReconcile]);
    expect(states.get("approve")).toEqual(["dismissed"]);
    await manager.close();
  });

  test("returns dismissed when the user cancels ctx.harness", async () => {
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
      session,
      instances: new PluginInstanceStore({ session }),
      snapshot: () => ({
        ...emptyReconcileSnapshot(session.id),
        harnessTargets: [{ id: "codex", harness: "codex" }],
      }),
      selectedHarnessTargetId: () => "codex",
      enqueueHarnessInvocation() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.harness({
          title: "Implement",
          prompt: "Implement run_1.",
          timeoutMs: 1_000,
          laneId: "main",
        });
        states.push(result.state);
      },
    });

    const reconcileKey = {
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };
    const reconcile = manager.enqueue(reconcileKey);
    await waitFor(() => manager.listHarnessInvocations().length === 1);
    const invocationId = manager.listHarnessInvocations()[0]!.invocationId;
    expect(await manager.cancelHarnessInvocation(invocationId)).toBe(true);
    expect(manager.listHarnessInvocations()[0]).toMatchObject({
      phase: "cancelled",
      cancellation: { reason: "user" },
    });
    await reconcile;
    expect(states).toEqual(["dismissed"]);
    await manager.close();
  });

  test("keeps draft dismissal separate from dispatch failure", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      session,
      pluginInstanceId: "reqloop_default",
    });
    for (const name of ["dismiss", "fail"]) {
      resources.create<Spec>({
        type: resourceType("Requirement"),
        name,
        spec: { value: name },
      });
    }
    const states = new Map<string, string[]>();
    const manager = new Manager({
      session,
      instances: new PluginInstanceStore({ session }),
      snapshot: () => ({
        ...emptyReconcileSnapshot(session.id),
        harnessTargets: [{ id: "codex", harness: "codex" }],
      }),
      selectedHarnessTargetId: () => "codex",
      enqueueHarnessInvocation() {
        throw new Error("dispatcher unavailable");
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx, resource) {
        const result = await ctx.verbs.draft({
          title: "Implement",
          prompt: `Implement ${resource.metadata.name}.`,
          timeoutMs: 1_000,
        });
        const observed = states.get(resource.metadata.name) ?? [];
        observed.push(
          result.state === "failure"
            ? `${result.state}:${result.error}`
            : result.state,
        );
        states.set(resource.metadata.name, observed);
      },
    });
    const reconcileKey = (resourceId: string) => ({
      batonSessionId: session.id,
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId,
    });

    const dismissReconcile = manager.enqueue(reconcileKey("dismiss"));
    const failReconcile = manager.enqueue(reconcileKey("fail"));
    await waitFor(() => session.loadState().interactions.size === 2);
    expect(manager.listHarnessInvocations()).toEqual([]);
    const interactions = [...session.loadState().interactions.values()]
      .map(({ interaction }) => interaction)
      .filter((interaction) => interaction.kind === "suggested_input");
    const dismissed = interactions.find((interaction) =>
      interaction.kind === "suggested_input" &&
      interaction.text === "Implement dismiss."
    );
    const failed = interactions.find((interaction) =>
      interaction.kind === "suggested_input" &&
      interaction.text === "Implement fail."
    );
    expect(await manager.completeInteraction(dismissed!.interactionId, {
      kind: "suggested_input",
      outcome: "dismissed",
    })).toBe(true);
    expect(await manager.completeInteraction(failed!.interactionId, {
      kind: "suggested_input",
      outcome: "submitted",
      blocks: [{ type: "text", text: "Implement fail." }],
    })).toBe(true);

    await waitFor(() =>
      states.get("dismiss")?.includes("dismissed") === true &&
      states.get("fail")?.includes(
          "failure:dispatcher unavailable",
        ) === true
    );
    expect(states.get("dismiss")).toEqual(["dismissed"]);
    expect(states.get("fail")).toEqual(["failure:dispatcher unavailable"]);
    await Promise.all([dismissReconcile, failReconcile]);
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
      instances: instanceStore(root),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          started.push("reqloop_default");
          await gate.promise;
          return;
        },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceType: resourceType("Deployment"),
      async reconcile() {
          started.push("deploy_default");
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
    const manager = new Manager({ instances: instanceStore(root) });
    manager.registerController(definition);

    expect(() => manager.registerController(definition)).toThrow(
      `plugin Controller already registered for bs_test/reqloop_default/v1/${API_VERSION}/Requirement`,
    );
    await expect(manager.enqueue(key("missing", "run_1"))).rejects.toThrow(
      `no plugin Controller registered for bs_test/missing/v1/${API_VERSION}/Requirement`,
    );
  });

  test("routes descendant namespace keys to a global Plugin Controller", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      namespace: "v1/project/project-a",
      spec: { value: "run_1" },
    });
    const reconciled: string[] = [];
    const manager = new Manager({ instances: instanceStore(root) });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(_context, resource) {
        reconciled.push(resource.metadata.namespace);
      },
    });

    await manager.enqueue({
      ...key("reqloop_default", "run_1"),
      namespace: "v1/project/project-a",
    });
    expect(reconciled).toEqual(["v1/project/project-a"]);
    await manager.close();
  });

  test("registration close is idempotent and removes only its Controller", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    const manager = new Manager({ instances: instanceStore(root) });
    const registration = manager.registerController({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {},
    });

    await expect(manager.enqueue(key("reqloop_default", "run_1"))).resolves.toBeUndefined();
    registration.close();
    registration.close();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      `no plugin Controller registered for bs_test/reqloop_default/v1/${API_VERSION}/Requirement`,
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      maxConcurrency: 1,
      async reconcile(_ctx, resource) {
          started.push(
            `reqloop_default/${resource.metadata.name}`,
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
            `deploy_default/${resource.metadata.name}`,
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
          instances: instanceStore(root),
        }),
    ).toThrow(
      "maxTotalConcurrency must be a positive integer",
    );
    expect(
      () =>
        new Manager({
          instances: instanceStore(root),
          retryBackoff: { initialDelayMs: 0 },
        }),
    ).toThrow("retryBackoff.initialDelayMs must be a positive integer");
    expect(
      () =>
        new Manager({
          instances: instanceStore(root),
          retryBackoff: { initialDelayMs: 20, maxDelayMs: 10 },
        }),
    ).toThrow("retryBackoff.maxDelayMs must be at least initialDelayMs");
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
      instances: instanceStore(root),
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
