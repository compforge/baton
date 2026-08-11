import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Controller,
  type ControllerOptions,
  type ReconcileKey,
} from "../src/plugin/controller.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";

interface Spec {
  requirement: string;
}

interface Status {
  phase?: string;
  observedGeneration?: number;
}

const roots: string[] = [];
const REQ_LOOP_RUN = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Requirement",
} as const;

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-controller-"));
  roots.push(root);
  return root;
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function store(root: string): PluginResourceStore {
  return new PluginResourceStore({
    session: testSession(root),
    pluginInstanceId: "reqloop_default",
  });
}

function key(resourceId: string = "run_1"): ReconcileKey {
  return {
    batonSessionId: "bs_test",
    pluginInstanceId: "reqloop_default",
    resourceApiVersion: REQ_LOOP_RUN.apiVersion,
    resourceKind: "Requirement",
    resourceId,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin Controller", () => {
  test("provides a frozen reconcile context and persists status and wake-up", async () => {
    const resources = store(testRoot());
    resources.create<Spec, Status>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    const reconcile: ControllerOptions<Spec, Status>["reconcile"] =
      async (ctx, resource) => {
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(resource)).toBe(true);
        expect(Object.isFrozen(resource.spec)).toBe(true);
        resources.patchStatus<Spec, Status>(
          REQ_LOOP_RUN,
          resource.metadata.name,
          {
            phase: "waiting_for_review",
            observedGeneration: resource.metadata.generation,
          },
          { expectedResourceVersion: resource.metadata.resourceVersion },
        );
        return { requeueAfterMs: 5_000 };
      };
    const controller = new Controller({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      reconcile,
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });

    await controller.enqueue(key());
    const saved = resources.get<Spec, Status>(REQ_LOOP_RUN, "run_1");
    expect(saved.status).toEqual({
      phase: "waiting_for_review",
      observedGeneration: 1,
    });
    expect(saved.metadata.generation).toBe(1);
    expect(saved.metadata.resourceVersion).toBe("2");
    expect(resources.scheduledReconciles(REQ_LOOP_RUN)[0]?.nextReconcileAt).toEqual(
      new Date("2026-07-25T00:00:05.000Z"),
    );
  });

  test("clears an earlier wake-up when reconcile does not request another", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    resources.setNextReconcileAt(
      REQ_LOOP_RUN,
      "run_1",
      new Date("2026-07-25T00:00:00.000Z"),
    );
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile() {},
    });

    await controller.enqueue(key());
    expect(resources.scheduledReconciles(REQ_LOOP_RUN)).toEqual([]);
  });

  test("finalizes a terminating Resource only after reconcile succeeds", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    resources.requestDeletion(
      REQ_LOOP_RUN,
      "run_1",
      new Date("2026-07-29T00:00:00.000Z"),
    );
    const deleted: string[] = [];
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile(_ctx, resource) {
        expect(resource.metadata.deletionTimestamp).toBe(
          "2026-07-29T00:00:00.000Z",
        );
      },
      onResourceDeleted(resource) {
        deleted.push(resource.metadata.name);
      },
    });

    await controller.enqueue(key());

    expect(deleted).toEqual(["run_1"]);
    expect(() => resources.get(REQ_LOOP_RUN, "run_1")).toThrow(
      "plugin resource not found",
    );
  });

  test("keeps a terminating Resource when reconcile fails", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    resources.requestDeletion(REQ_LOOP_RUN, "run_1");
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile() {
        throw new Error("cleanup failed");
      },
    });

    await expect(controller.enqueue(key())).rejects.toThrow("cleanup failed");
    expect(
      resources.get(REQ_LOOP_RUN, "run_1").metadata.deletionTimestamp,
    ).toBeDefined();
  });

  test("rejects a stale reconcile when spec changes while it is running", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "draft" },
    });
    const entered = deferred();
    const release = deferred();
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile() {
          entered.resolve();
          await release.promise;
        return;
        },
    });

    const running = controller.enqueue(key());
    await entered.promise;
    resources.replaceSpec(REQ_LOOP_RUN, "run_1", { requirement: "approved revision" });
    release.resolve();

    await expect(running).rejects.toThrow(
      "plugin resource generation changed during reconcile",
    );
  });

  test("serializes the same resource across separate Controller instances", async () => {
    const root = testRoot();
    const firstStore = store(root);
    const secondStore = store(root);
    firstStore.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    const gate = deferred();
    let runs = 0;
    let active = 0;
    let maximumActive = 0;
    const reconcile: ControllerOptions<Spec, Status>["reconcile"] =
      async () => {
        runs += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (runs === 1) await gate.promise;
        active -= 1;
      };
    const firstController = new Controller({
      store: firstStore,
      resourceType: REQ_LOOP_RUN,
      reconcile,
    });
    const secondController = new Controller({
      store: secondStore,
      resourceType: REQ_LOOP_RUN,
      reconcile,
    });

    const first = firstController.enqueue(key());
    const second = secondController.enqueue(key());
    await Promise.resolve();
    expect(runs).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(runs).toBe(2);
    expect(maximumActive).toBe(1);
  });

  test("coalesces triggers received during execution into one follow-up", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    const gate = deferred();
    let runs = 0;
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile() {
          runs += 1;
          if (runs === 1) await gate.promise;
        },
    });

    const first = controller.enqueue(key());
    const followUp = controller.enqueue(key());
    const duplicateFollowUp = controller.enqueue(key());
    expect(followUp).not.toBe(first);
    expect(duplicateFollowUp).toBe(followUp);
    gate.resolve();
    await Promise.all([first, followUp, duplicateFollowUp]);

    expect(runs).toBe(2);
  });

  test("coalesces duplicate pending resources", async () => {
    const resources = store(testRoot());
    for (const resourceId of ["run_1", "run_2"]) {
      resources.create<Spec>({
        type: REQ_LOOP_RUN,
        name: resourceId,
        spec: { requirement: resourceId },
      });
    }
    const gate = deferred();
    const seen: string[] = [];
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile(_ctx, resource) {
          seen.push(resource.metadata.name);
          if (resource.metadata.name === "run_1") await gate.promise;
        },
    });

    const first = controller.enqueue(key("run_1"));
    const pending = controller.enqueue(key("run_2"));
    const duplicate = controller.enqueue(key("run_2"));
    expect(duplicate).toBe(pending);
    gate.resolve();
    await Promise.all([first, pending, duplicate]);

    expect(seen).toEqual(["run_1", "run_2"]);
  });

  test("close lets running work settle but rejects pending and future enqueue", async () => {
    const resources = store(testRoot());
    for (const resourceId of ["run_1", "run_2"]) {
      resources.create<Spec>({
        type: REQ_LOOP_RUN,
        name: resourceId,
        spec: { requirement: resourceId },
      });
    }
    const gate = deferred();
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile() {
          await gate.promise;
        },
    });

    const running = controller.enqueue(key("run_1"));
    const pending = controller.enqueue(key("run_2"));
    controller.close();
    await expect(pending).rejects.toThrow("plugin Controller is closed");
    await expect(controller.enqueue(key("run_2"))).rejects.toThrow(
      "plugin Controller is closed",
    );
    gate.resolve();
    await expect(running).resolves.toBeUndefined();
  });

  test("runs different resources up to its configured capacity", async () => {
    const resources = store(testRoot());
    for (const resourceId of ["run_1", "run_2", "run_3"]) {
      resources.create<Spec>({
        type: REQ_LOOP_RUN,
        name: resourceId,
        spec: { requirement: resourceId },
      });
    }
    const gate = deferred();
    const started: string[] = [];
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      maxConcurrency: 2,
      async reconcile(_ctx, resource) {
          started.push(resource.metadata.name);
          await gate.promise;
        },
    });

    const first = controller.enqueue(key("run_1"));
    const second = controller.enqueue(key("run_2"));
    const third = controller.enqueue(key("run_3"));
    await Promise.resolve();
    expect(started).toEqual(["run_1", "run_2"]);

    gate.resolve();
    await Promise.all([first, second, third]);
    expect(started).toEqual(["run_1", "run_2", "run_3"]);
  });

  test("continues draining after one resource fails", async () => {
    const resources = store(testRoot());
    for (const resourceId of ["run_1", "run_2"]) {
      resources.create<Spec>({
        type: REQ_LOOP_RUN,
        name: resourceId,
        spec: { requirement: resourceId },
      });
    }
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile(_ctx, resource) {
          if (resource.metadata.name === "run_1") {
            throw new Error("connector unavailable");
          }
        },
    });

    const failed = controller.enqueue(key("run_1"));
    const next = controller.enqueue(key("run_2"));
    await expect(failed).rejects.toThrow("connector unavailable");
    await expect(next).resolves.toBeUndefined();
  });

  test("owns an immutable key snapshot", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    const gate = deferred();
    const seen: string[] = [];
    const controller = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile(_ctx, resource) {
          await gate.promise;
          seen.push(resource.metadata.name);
        },
    });
    const mutable = key();

    const completion = controller.enqueue(mutable);
    (mutable as { resourceId: string }).resourceId = "changed";
    gate.resolve();
    await completion;

    expect(seen).toEqual(["run_1"]);
  });

  test("rejects invalid results, capacity, and keys outside its scope", async () => {
    const resources = store(testRoot());
    resources.create<Spec>({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
    });
    const invalid: ControllerOptions<Spec, Status>["reconcile"] =
      async () => {
        return { requeueAfterMs: 0 };
      };
    const controller = new Controller({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      reconcile: invalid,
    });

    await expect(controller.enqueue(key())).rejects.toThrow(
      "reconcile requeueAfterMs must be a positive integer",
    );
    await expect(
      controller.enqueue({ ...key(), pluginInstanceId: "another_instance" }),
    ).rejects.toThrow("reconcile key is outside controller scope");
    const invalidDeadline = new Controller<Spec, Status>({
      store: resources,
      resourceType: REQ_LOOP_RUN,
      async reconcile(ctx) {
        await ctx.ask({
          key: "review",
          title: "Review",
          prompt: "Continue?",
          expiresAt: "tomorrow",
        });
      },
    });
    await expect(invalidDeadline.enqueue(key())).rejects.toThrow(
      "ask expiresAt must be an ISO 8601 timestamp with a timezone",
    );
    expect(
      () =>
        new Controller({
          store: resources,
          resourceType: REQ_LOOP_RUN,
          reconcile: invalid,
          maxConcurrency: 0,
        }),
    ).toThrow("maxConcurrency must be a positive integer");
  });
});
