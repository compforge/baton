import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ReconcileKey,
  ReconcileScope,
} from "../src/plugin/controller.ts";
import { Manager } from "../src/plugin/manager.ts";
import { type Proposal, ProposalStore } from "../src/plugin/proposal.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";
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
  test("persists a Resource Interaction and reconciles its answer", async () => {
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
    const snapshots: unknown[] = [];
    const manager = new Manager({
      proposals: new ProposalStore({ session }),
      session,
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(baton) {
        const current = baton.pluginInteractions.find(
          (interaction) => interaction.decisionKey === "associate-pr",
        );
        snapshots.push(current?.outcome);
        if (current?.outcome) return;
        return {
          output: {
            kind: "interaction",
            decisionKey: "associate-pr",
            title: "Associate pull request",
            prompt: "Choose a requirement",
            options: [
              { optionId: "req_1", label: "REQ-1" },
              {
                optionId: "reject",
                label: "Do not associate",
                role: "reject",
              },
            ],
          },
        };
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
    expect(snapshots).toEqual([
      undefined,
      { kind: "answered", values: ["req_1"] },
    ]);
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

  test("routes many Plugin instances through one globally bounded capacity", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "Requirement", "run_1");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const proposals: Proposal[] = [];
    const persisted = proposalStore(root);
    const manager = new Manager({
      maxTotalConcurrency: 1,
      proposals: persisted,
      onProposal(proposal) {
        expect(persisted.get(proposal.proposalId)).toEqual(proposal);
        proposals.push(proposal);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      async reconcile(_baton, resource) {
          started.push(resource.metadata.namespace);
          await gate.promise;
          return {
            output: {
              kind: "proposed-input",
              text: "Review requirement",
            },
          };
        },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceType: resourceType("Deployment"),
      async reconcile(_baton, resource) {
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
    expect(proposals.map((proposal) => proposal.text)).toEqual(["Review requirement"]);
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
      async reconcile(_baton, resource) {
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
      async reconcile(_baton, resource) {
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

  test("does not surface the same Proposal again after the user resolves it", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    const surfaced: Proposal[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal(proposal) {
        surfaced.push(proposal);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          return {
            output: {
              kind: "proposed-input",
              text: "Review requirement",
            },
          };
        },
    });

    await manager.enqueue(key("reqloop_default", "run_1"));
    expect(surfaced).toHaveLength(1);
    const proposal = surfaced[0] as Proposal;
    expect(manager.resolveProposal(proposal.proposalId, "dismissed").resolution?.outcome).toBe(
      "dismissed",
    );

    await manager.enqueue(key("reqloop_default", "run_1"));
    expect(surfaced).toHaveLength(1);
    expect(manager.listPendingProposals()).toEqual([]);
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
      async reconcile(_baton, resource) {
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
      async reconcile(_baton, resource) {
          runs.push(resource.metadata.name);
        },
    });

    await manager.start();
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
      async reconcile(_baton, resource) {
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
      async reconcile(_baton, resource) {
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
