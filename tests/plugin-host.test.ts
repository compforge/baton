import { describe, expect, test } from "bun:test";

import {
  desiredPluginBindings,
  PluginHost,
  type PluginBindingDefinition,
  type PluginHostPackage,
} from "../src/plugin/host.ts";

function plugin(
  namespace: PluginHostPackage["namespace"],
): PluginHostPackage {
  return {
    pluginId: "compforge/reqloop",
    marketplace: "reqloop",
    packageVersion: "1.0.0",
    namespace,
    config: {},
  };
}

const sessions = [
  { sessionId: "s1", projectId: "project-a", cwd: "/project/a" },
  { sessionId: "s2", projectId: "project-a", cwd: "/project/a" },
  { sessionId: "s3", projectId: "project-b", cwd: "/project/b" },
] as const;

describe("Plugin Host", () => {
  test("derives Worker cardinality from the Package namespace", () => {
    expect(
      desiredPluginBindings(plugin("v1"), sessions).map((binding) => binding.namespace),
    ).toEqual(["v1"]);
    expect(
      desiredPluginBindings(plugin("v1/project"), sessions)
        .map((binding) => binding.namespace),
    ).toEqual(["v1/project/project-a", "v1/project/project-b"]);
    expect(
      desiredPluginBindings(plugin("v1/project/session"), sessions)
        .map((binding) => binding.namespace),
    ).toEqual([
      "v1/project/project-a/session/s1",
      "v1/project/project-a/session/s2",
      "v1/project/project-b/session/s3",
    ]);
  });

  test("keeps one Worker when two Sessions share a project Binding", async () => {
    const started: PluginBindingDefinition[] = [];
    const stopped: string[] = [];
    const host = new PluginHost({
      async launch(binding) {
        started.push(binding);
        return {
          pid: 123,
          async close() {
            stopped.push(binding.bindingId);
          },
        };
      },
    });

    await host.reconcile([plugin("v1/project")], sessions.slice(0, 2));
    expect(started).toHaveLength(1);
    expect(host.list()).toMatchObject([{
      namespace: "v1/project/project-a",
      phase: "running",
      pid: 123,
    }]);

    await host.reconcile([plugin("v1/project")], sessions);
    expect(started).toHaveLength(2);
    expect(host.list().map((binding) => binding.namespace)).toEqual([
      "v1/project/project-a",
      "v1/project/project-b",
    ]);

    await host.close();
    expect(stopped).toHaveLength(2);
  });

  test("restarts only the Binding whose immutable input changed", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const host = new PluginHost({
      async launch(binding) {
        started.push(`${binding.namespace}@${binding.packageVersion}`);
        return {
          async close() {
            stopped.push(`${binding.namespace}@${binding.packageVersion}`);
          },
        };
      },
    });
    await host.reconcile([plugin("v1/project")], sessions);
    await host.reconcile([{ ...plugin("v1/project"), packageVersion: "1.1.0" }], sessions);

    expect(started).toEqual([
      "v1/project/project-a@1.0.0",
      "v1/project/project-b@1.0.0",
      "v1/project/project-a@1.1.0",
      "v1/project/project-b@1.1.0",
    ]);
    expect(stopped).toEqual([
      "v1/project/project-a@1.0.0",
      "v1/project/project-b@1.0.0",
    ]);
    await host.close();
  });

  test("keeps project Workers after the last Session detaches", async () => {
    let starts = 0;
    const host = new PluginHost({
      async launch() {
        starts += 1;
        return { async close() {} };
      },
    });
    const projects = [{ projectId: "project-a", cwd: "/project/a" }];
    await host.reconcile([plugin("v1/project")], [], projects);
    await host.reconcile([plugin("v1/project")], [], projects);

    expect(starts).toBe(1);
    expect(host.list()[0]?.namespace).toBe("v1/project/project-a");
    await host.close();
  });

  test("does not retry a failed Binding on an unrelated Session heartbeat", async () => {
    let starts = 0;
    const host = new PluginHost({
      async launch() {
        starts += 1;
        throw new Error("activation failed");
      },
    });
    await host.reconcile([plugin("v1/project")], sessions.slice(0, 2));
    await host.reconcile([plugin("v1/project")], sessions.slice(0, 2));

    expect(starts).toBe(1);
    expect(host.list()[0]).toMatchObject({
      namespace: "v1/project/project-a",
      phase: "failed",
      error: "activation failed",
    });
    await host.close();
  });
});
