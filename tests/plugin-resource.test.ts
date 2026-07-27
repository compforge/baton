import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginResourceStore } from "../src/plugin/resource.ts";

const roots: string[] = [];
const REQ_LOOP_RUN = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "ReqLoopRun",
} as const;
const OTHER = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "OtherKind",
} as const;

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-resource-"));
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PluginResourceStore", () => {
  test("creates a resource in its BatonSession and plugin instance scope", () => {
    const root = testRoot();
    const resources = store(root);
    const created = resources.create({
      type: REQ_LOOP_RUN,
      spec: { requirement: "ship it" },
      status: { phase: "pending" },
    });

    expect(created).toMatchObject({
      ...REQ_LOOP_RUN,
      metadata: {
        namespace: "reqloop_default",
        generation: 1,
        resourceVersion: "1",
      },
    });
    expect(created.metadata.name).toMatch(/^pr_/);
    expect(created.metadata.uid).toMatch(/^pr_/);
    expect(created.metadata).toMatchObject({
      generation: 1,
      resourceVersion: "1",
    });
    expect(resources.get(REQ_LOOP_RUN, created.metadata.name)).toEqual(created);
    expect(resources.list(REQ_LOOP_RUN)).toEqual([created]);
    expect(resources.list(OTHER)).toEqual([]);

    const path = join(
      root,
      "projects",
      "project",
      "sessions",
      "bs_test",
      "plugins",
      "reqloop_default",
      "resources",
      "reqloop.baton.dev",
      "v1alpha1",
      "ReqLoopRun",
      `${created.metadata.name}.json`,
    );
    expect(existsSync(path)).toBe(true);
  });

  test("spec changes generation while status and schedule changes do not", () => {
    const resources = store(testRoot());
    const created = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "draft" },
      status: { phase: "pending", evidence: "keep" },
    });

    const spec = resources.replaceSpec(REQ_LOOP_RUN, "run_1", { requirement: "approved" });
    expect(spec.metadata.generation).toBe(2);
    expect(spec.metadata.resourceVersion).toBe("2");

    const status = resources.patchStatus(REQ_LOOP_RUN, "run_1", {
      phase: "running",
      evidence: null,
    });
    expect(status.metadata.generation).toBe(2);
    expect(status.metadata.resourceVersion).toBe("3");
    expect(status.status).toEqual({ phase: "running", evidence: null });

    const due = new Date("2026-07-25T01:02:03.000Z");
    resources.setNextReconcileAt(REQ_LOOP_RUN, "run_1", due);
    const scheduled = resources.get(REQ_LOOP_RUN, "run_1");
    expect(scheduled.metadata.generation).toBe(2);
    expect(scheduled.metadata.resourceVersion).toBe("3");
    expect("nextReconcileAt" in scheduled.metadata).toBe(false);
    expect(resources.scheduledReconciles(REQ_LOOP_RUN)).toEqual([
      { resource: scheduled, nextReconcileAt: due },
    ]);

    resources.setNextReconcileAt(REQ_LOOP_RUN, "run_1", null);
    const cleared = resources.get(REQ_LOOP_RUN, "run_1");
    expect(cleared.metadata.generation).toBe(2);
    expect(cleared.metadata.resourceVersion).toBe("3");
    expect(resources.scheduledReconciles(REQ_LOOP_RUN)).toEqual([]);
    expect(created.metadata.generation).toBe(1);
  });

  test("no-op updates do not advance resourceVersion", () => {
    const resources = store(testRoot());
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "same" },
      status: { phase: "pending" },
    });

    expect(
      resources.replaceSpec(REQ_LOOP_RUN, "run_1", { requirement: "same" }).metadata
        .resourceVersion,
    ).toBe("1");
    expect(
      resources.patchStatus(REQ_LOOP_RUN, "run_1", { phase: "pending" }).metadata.resourceVersion,
    ).toBe("1");
    resources.setNextReconcileAt(REQ_LOOP_RUN, "run_1", null);
    expect(resources.get(REQ_LOOP_RUN, "run_1").metadata.resourceVersion).toBe("1");
  });

  test("checks expected resourceVersion inside the write lock", () => {
    const resources = store(testRoot());
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "draft" },
    });
    resources.patchStatus(REQ_LOOP_RUN, "run_1", { phase: "running" });

    expect(() =>
      resources.replaceSpec(
        REQ_LOOP_RUN,
        "run_1",
        { requirement: "stale writer" },
        { expectedResourceVersion: "1" },
      ),
    ).toThrow("plugin resource version conflict: expected 1, current 2");
  });

  test("rejects unsafe identities and values that cannot round-trip as JSON", () => {
    const root = testRoot();
    expect(
      () =>
        new PluginResourceStore({
          session: { id: "../escape", dir: root },
          pluginInstanceId: "reqloop_default",
        }),
    ).toThrow("batonSessionId");

    const resources = store(root);
    expect(() =>
      resources.create({
        type: REQ_LOOP_RUN,
        name: "run_1",
        spec: { requirement: undefined },
      }),
    ).toThrow("spec must contain only lossless JSON values");
  });

  test("reports corrupt or wrongly scoped persisted resources", () => {
    const root = testRoot();
    const path = join(
      root,
      "projects",
      "project",
      "sessions",
      "bs_test",
      "plugins",
      "reqloop_default",
      "resources",
      "ReqLoopRun",
      "run_1.json",
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        kind: "ReqLoopRun",
        metadata: {
          resourceId: "run_1",
          batonSessionId: "bs_another",
          pluginInstanceId: "reqloop_default",
          generation: 1,
          resourceVersion: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        spec: {},
        status: {},
      }),
    );

    expect(() => store(root).get(REQ_LOOP_RUN, "run_1")).toThrow(
      `invalid plugin resource ${path}: batonSessionId must be bs_test`,
    );
    expect(readFileSync(path, "utf8")).toContain("bs_another");
  });

  test("reads the legacy flat envelope through the standard Resource shape", () => {
    const root = testRoot();
    const path = join(
      root,
      "projects",
      "project",
      "sessions",
      "bs_test",
      "plugins",
      "reqloop_default",
      "resources",
      "ReqLoopRun",
      "run_legacy.json",
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        kind: "ReqLoopRun",
        metadata: {
          resourceId: "run_legacy",
          batonSessionId: "bs_test",
          pluginInstanceId: "reqloop_default",
          generation: 2,
          resourceVersion: 3,
          createdAt: "2026-07-25T00:00:00.000Z",
          updatedAt: "2026-07-25T00:01:00.000Z",
          nextReconcileAt: "2026-07-25T01:00:00.000Z",
        },
        spec: { requirement: "legacy" },
        status: { phase: "pending" },
      }),
    );

    const resources = store(root);
    const resource = resources.get(REQ_LOOP_RUN, "run_legacy");
    expect(resource).toMatchObject({
      ...REQ_LOOP_RUN,
      metadata: {
        name: "run_legacy",
        namespace: "reqloop_default",
        generation: 2,
        resourceVersion: "3",
        creationTimestamp: "2026-07-25T00:00:00.000Z",
      },
    });
    expect(resource.metadata.uid).toMatch(/^res_[0-9a-f]{64}$/);
    expect(resources.scheduledReconciles(REQ_LOOP_RUN)).toEqual([
      {
        resource,
        nextReconcileAt: new Date("2026-07-25T01:00:00.000Z"),
      },
    ]);
  });

  test("assigns a new uid when the same name is recreated", () => {
    const resources = store(testRoot());
    const first = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: {},
    });
    resources.delete(REQ_LOOP_RUN, "run_1");
    const replacement = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: {},
    });

    expect(replacement.metadata.name).toBe(first.metadata.name);
    expect(replacement.metadata.uid).not.toBe(first.metadata.uid);
  });

  test("keeps the same kind and name isolated across apiVersions", () => {
    const resources = store(testRoot());
    const nextVersion = {
      apiVersion: "reqloop.baton.dev/v1beta1",
      kind: REQ_LOOP_RUN.kind,
    } as const;
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { version: "alpha" },
    });
    resources.create({
      type: nextVersion,
      name: "run_1",
      spec: { version: "beta" },
    });

    expect(resources.get(REQ_LOOP_RUN, "run_1").spec).toEqual({
      version: "alpha",
    });
    expect(resources.get(nextVersion, "run_1").spec).toEqual({
      version: "beta",
    });
  });
});
