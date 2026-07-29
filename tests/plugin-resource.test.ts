import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginResourceStore } from "../src/plugin/resource.ts";

const roots: string[] = [];
const REQ_LOOP_RUN = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "Requirement",
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
      labels: {
        "reqloop.baton.dev/requirement": "REQ-1",
      },
      annotations: {
        "example.com/display-name": "Ship it",
      },
      spec: { requirement: "ship it" },
      status: { phase: "pending" },
    });

    expect(created).toMatchObject({
      ...REQ_LOOP_RUN,
      metadata: {
        namespace: "reqloop_default",
        generation: 1,
        resourceVersion: "1",
        labels: {
          "reqloop.baton.dev/requirement": "REQ-1",
        },
        annotations: {
          "example.com/display-name": "Ship it",
        },
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
      "Requirement",
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
    expect(
      resources.patchMetadata(REQ_LOOP_RUN, "run_1", {}).metadata
        .resourceVersion,
    ).toBe("1");
    resources.setNextReconcileAt(REQ_LOOP_RUN, "run_1", null);
    expect(resources.get(REQ_LOOP_RUN, "run_1").metadata.resourceVersion).toBe("1");
  });

  test("patches Plugin metadata by key without changing generation", () => {
    const resources = store(testRoot());
    const created = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      annotations: {
        "example.com/keep": "yes",
        "example.com/remove": "old",
      },
      spec: { requirement: "same" },
    });

    const patched = resources.patchMetadata(
      REQ_LOOP_RUN,
      "run_1",
      {
        labels: {
          "example.com/policy": "retained",
        },
        annotations: {
          "example.com/remove": null,
          "reqloop.baton.dev/delete-after": "2026-08-01T00:00:00.000Z",
        },
      },
      { expectedResourceVersion: created.metadata.resourceVersion },
    );

    expect(patched.metadata.generation).toBe(1);
    expect(patched.metadata.resourceVersion).toBe("2");
    expect(patched.metadata.labels).toEqual({
      "example.com/policy": "retained",
    });
    expect(patched.metadata.annotations).toEqual({
      "example.com/keep": "yes",
      "reqloop.baton.dev/delete-after": "2026-08-01T00:00:00.000Z",
    });
    expect(() =>
      resources.patchMetadata(REQ_LOOP_RUN, "run_1", {
        annotations: {
          "example.com/invalid": 1 as unknown as string,
        },
      })
    ).toThrow("metadata annotations patch");
  });

  test("selects Resources by constrained labels while annotations stay opaque", () => {
    const resources = store(testRoot());
    const first = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      labels: {
        "reqloop.baton.dev/source": "forge",
        state: "open",
      },
      annotations: {
        "user note with spaces": JSON.stringify({
          reason: "keep this text unindexed",
        }),
      },
      spec: { requirement: "first" },
    });
    resources.create({
      type: REQ_LOOP_RUN,
      name: "run_2",
      labels: {
        "reqloop.baton.dev/source": "forge",
        state: "closed",
      },
      spec: { requirement: "second" },
    });

    expect(
      resources.list(REQ_LOOP_RUN, {
        matchLabels: {
          "reqloop.baton.dev/source": "forge",
          state: "open",
        },
      }),
    ).toEqual([first]);
    expect(
      resources.list(REQ_LOOP_RUN, {
        matchLabels: { state: "missing" },
      }),
    ).toEqual([]);

    expect(() =>
      resources.create({
        type: REQ_LOOP_RUN,
        name: "bad_key",
        labels: { "Bad Prefix/source": "forge" },
        spec: {},
      })
    ).toThrow("invalid DNS prefix");
    expect(() =>
      resources.create({
        type: REQ_LOOP_RUN,
        name: "bad_value",
        labels: { state: "has spaces" },
        spec: {},
      })
    ).toThrow("valid label value");
    expect(() =>
      resources.list(REQ_LOOP_RUN, {
        matchLabels: { state: "has spaces" },
      })
    ).toThrow("valid label value");
  });

  test("reports whether a Source observation materialized a new Resource", () => {
    const resources = store(testRoot());
    const first = resources.ensure({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "same" },
    });
    const repeated = resources.ensure({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "same" },
    });

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.resource).toEqual(first.resource);

    const annotated = resources.patchMetadata<{ requirement: string }>(
      REQ_LOOP_RUN,
      "run_1",
      {
        labels: { "example.com/extra": "preserved" },
        annotations: {
          "reqloop.baton.dev/delete-after": "2026-08-01T00:00:00.000Z",
        },
      },
    );
    expect(
      resources.ensure({
        type: REQ_LOOP_RUN,
        name: "run_1",
        spec: { requirement: "same" },
      }).resource,
    ).toEqual(annotated);
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
      "reqloop.baton.dev",
      "v1alpha1",
      "Requirement",
      "run_1.json",
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        object: {
          ...REQ_LOOP_RUN,
          metadata: {
            name: "run_1",
            namespace: "another_instance",
            uid: "pr_test",
            generation: 1,
            resourceVersion: "1",
            creationTimestamp: new Date().toISOString(),
          },
          spec: {},
          status: {},
        },
        control: {},
      }),
    );

    expect(() => store(root).get(REQ_LOOP_RUN, "run_1")).toThrow(
      `invalid plugin resource ${path}: namespace must be reqloop_default`,
    );
    expect(readFileSync(path, "utf8")).toContain("another_instance");
  });

  test("assigns a new uid when the same name is recreated", () => {
    const resources = store(testRoot());
    const first = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: {},
    });
    resources.requestDeletion(REQ_LOOP_RUN, "run_1");
    resources.finalizeDeletion(REQ_LOOP_RUN, "run_1");
    const replacement = resources.create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: {},
    });

    expect(replacement.metadata.name).toBe(first.metadata.name);
    expect(replacement.metadata.uid).not.toBe(first.metadata.uid);
  });

  test("pins structural owners and cascades deletion requests", () => {
    const resources = store(testRoot());
    const workspace = resources.create({
      type: REQ_LOOP_RUN,
      name: "workspace",
      spec: {},
    });
    const repository = resources.create({
      type: OTHER,
      name: "repository",
      owner: {
        ...REQ_LOOP_RUN,
        namespace: workspace.metadata.namespace,
        name: workspace.metadata.name,
        uid: workspace.metadata.uid,
      },
      spec: {},
    });
    const pullRequest = resources.create({
      type: REQ_LOOP_RUN,
      name: "pull-request",
      owner: {
        ...OTHER,
        namespace: repository.metadata.namespace,
        name: repository.metadata.name,
        uid: repository.metadata.uid,
      },
      spec: {},
    });
    const deletionTime = new Date("2026-07-29T01:02:03.000Z");

    const updates = resources.requestDeletion(
      REQ_LOOP_RUN,
      workspace.metadata.name,
      deletionTime,
    );

    expect(updates.map(({ resource }) => resource.metadata.uid)).toEqual([
      workspace.metadata.uid,
      repository.metadata.uid,
      pullRequest.metadata.uid,
    ]);
    for (const resource of [
      resources.get(REQ_LOOP_RUN, workspace.metadata.name),
      resources.get(OTHER, repository.metadata.name),
      resources.get(REQ_LOOP_RUN, pullRequest.metadata.name),
    ]) {
      expect(resource.metadata.deletionTimestamp).toBe(
        deletionTime.toISOString(),
      );
      expect(resource.metadata.resourceVersion).toBe("2");
    }
    expect(
      resources.requestDeletion(
        REQ_LOOP_RUN,
        workspace.metadata.name,
        new Date("2026-07-30T00:00:00.000Z"),
      ),
    ).toEqual([]);
    expect(() =>
      resources.create({
        type: OTHER,
        name: "late-child",
        owner: {
          ...REQ_LOOP_RUN,
          namespace: workspace.metadata.namespace,
          name: workspace.metadata.name,
          uid: workspace.metadata.uid,
        },
        spec: {},
      })
    ).toThrow("plugin resource owner is being deleted");
  });

  test("rejects an owner reference to a replaced incarnation", () => {
    const resources = store(testRoot());
    const owner = resources.create({
      type: REQ_LOOP_RUN,
      name: "workspace",
      spec: {},
    });

    expect(() =>
      resources.create({
        type: OTHER,
        name: "repository",
        owner: {
          ...REQ_LOOP_RUN,
          namespace: owner.metadata.namespace,
          name: owner.metadata.name,
          uid: "pr_replaced",
        },
        spec: {},
      })
    ).toThrow("plugin resource owner uid does not match");
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
