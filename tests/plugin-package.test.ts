import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emptyBatonSnapshot } from "../src/plugin/baton-snapshot.ts";
import { Manager, type PluginToast } from "../src/plugin/manager.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import type {
  PluginActivationContext,
  PluginPackage,
} from "../src/plugin/package.ts";
import { BATON_TURN_RESOURCE_TYPE } from "../src/plugin/package.ts";
import { ProposalStore } from "../src/plugin/proposal.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];
const REQ_LOOP_RUN = {
  apiVersion: "reqloop.baton.dev/v1alpha1",
  kind: "ReqLoopRun",
} as const;

function resourceType(kind: string) {
  return { apiVersion: "tests.baton.dev/v1alpha1", kind };
}

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-package-"));
  roots.push(root);
  return root;
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function stores(root: string): {
  instances: PluginInstanceStore;
  proposals: ProposalStore;
} {
  const session = testSession(root);
  return {
    instances: new PluginInstanceStore({ session }),
    proposals: new ProposalStore({ session }),
  };
}

function resourceStore(root: string, pluginInstanceId: string): PluginResourceStore {
  return new PluginResourceStore({
    session: testSession(root),
    pluginInstanceId,
  });
}

function key(pluginInstanceId: string, resourceId: string) {
  return {
    batonSessionId: "bs_test",
    pluginInstanceId,
    resourceApiVersion: REQ_LOOP_RUN.apiVersion,
    resourceKind: "ReqLoopRun",
    resourceId,
  };
}

function reqloopPackage(
  activate: PluginPackage["activate"],
  version = "1.2.0",
): PluginPackage {
  return {
    pluginId: "qiankun/reqloop",
    version,
    activate,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Plugin Package lifecycle", () => {
  test("scopes ContextProviders by Plugin name and removes them on deactivate", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.registerContextProvider({
            kind: "requirement",
            search() {
              return [{
                id: "req_1",
                label: "Ship it",
              }];
            },
            provide(id) {
              return id === "req_1" ? "Requirement: Ship it" : undefined;
            },
          });
        }),
      ],
      onProposal() {},
    });

    await manager.start();
    expect(manager.listContextCandidates("")).toEqual([{
      group: "reqloop@requirement",
      insert: "@reqloop.requirement:req_1",
      label: "Ship it",
      detail: "",
    }]);
    await expect(
      manager.provideContext("@reqloop.requirement:req_1", 1_024),
    ).resolves.toEqual(["Requirement: Ship it"]);

    await manager.deactivateInstance("reqloop_default");
    expect(manager.listContextCandidates("")).toEqual([]);
    await manager.close();
  });

  test("activates Resource Sources through the public Controller contract", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let runs = 0;
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.registerController({
            resourceType: REQ_LOOP_RUN,
            sources: [{
              type: "resource",
              sourceId: "poll-pr-state",
              start(source) {
                source.emit({
                  name: "run_1",
                  spec: { requirement: "ship it" },
                });
              },
            }],
            async reconcile() {
              runs += 1;
            },
          });
        }),
      ],
      onProposal() {},
    });

    await manager.start();
    await waitFor(() => runs === 1);
    await manager.deactivateInstance("reqloop_default");
    await manager.close();
  });

  test("automatically reconciles created Resources and status changes", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let context: PluginActivationContext | undefined;
    const phases: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((activation) => {
          context = activation;
          activation.registerController<
            { requirement: string },
            { phase?: string }
          >({
            resourceType: REQ_LOOP_RUN,
            async reconcile(_baton, resource) {
              phases.push(resource.status.phase ?? "pending");
              if (resource.status.phase === undefined) {
                activation.resources.patchStatus(resource, {
                  phase: "ready",
                });
              }
            },
          });
        }),
      ],
      onProposal() {},
    });

    await manager.start();
    context!.resources.create(REQ_LOOP_RUN, {
      name: "run_1",
      spec: { requirement: "ship it" },
    });

    await waitFor(() => phases.length === 2);
    expect(phases).toEqual(["pending", "ready"]);

    await manager.close();
  });

  test("presents active Resources as Board items and invalidates on status changes", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    resourceStore(root, "reqloop_default").create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
      status: { phase: "pending" },
    });
    let context: PluginActivationContext | undefined;
    let boardChanges = 0;
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((activation) => {
          context = activation;
          activation.registerController<
            { requirement: string },
            { phase: string }
          >({
            resourceType: REQ_LOOP_RUN,
            async reconcile() {},
            present(resource) {
              return {
                title: resource.spec.requirement,
                status: resource.status.phase,
              };
            },
          });
        }),
      ],
      onProposal() {},
      onBoardChanged() {
        boardChanges += 1;
      },
    });

    await manager.start();
    expect(manager.listBoardItems()).toEqual([
      {
        id: JSON.stringify([
          "reqloop_default",
          REQ_LOOP_RUN.apiVersion,
          "ReqLoopRun",
          "run_1",
        ]),
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        resourceKind: "ReqLoopRun",
        resourceId: "run_1",
        title: "ship it",
        status: "pending",
      },
    ]);

    const resource = context!.resources.get<
      { requirement: string },
      { phase: string }
    >(REQ_LOOP_RUN, "run_1");
    context!.resources.patchStatus(resource, { phase: "ready" });
    expect(manager.listBoardItems()[0]?.status).toBe("ready");
    expect(boardChanges).toBeGreaterThanOrEqual(2);

    await manager.deactivateInstance("reqloop_default");
    expect(manager.listBoardItems()).toEqual([]);
    await manager.close();
  });

  test("exposes a frozen, Instance-scoped Resource client to reconcile code", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    resourceStore(root, "reqloop_default").create({
      type: REQ_LOOP_RUN,
      name: "run_1",
      spec: { requirement: "ship it" },
      status: { phase: "pending" },
    });
    const foreign = resourceStore(root, "another_instance").create({
      type: REQ_LOOP_RUN,
      name: "run_2",
      spec: { requirement: "do not touch" },
      status: { phase: "pending" },
    });
    let context: PluginActivationContext | undefined;
    const toasts: PluginToast[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [reqloopPackage((activation) => {
        context = activation;
        activation.toast.show({
          text: "Connector ready",
          tone: "success",
        });
      })],
      snapshot: () => {
        const snapshot = emptyBatonSnapshot("bs_test");
        return {
          ...snapshot,
          session: { ...snapshot.session, cwd: root },
        };
      },
      onProposal() {},
      onToast(toast) {
        toasts.push(toast);
      },
    });

    await manager.start();
    expect(context!.session).toEqual({
      batonSessionId: "bs_test",
      cwd: root,
    });
    expect(Object.isFrozen(context!.session)).toBe(true);
    expect(Object.isFrozen(context!.toast)).toBe(true);
    expect(Object.isFrozen(context!.logger)).toBe(true);
    expect(toasts).toEqual([
      {
        pluginInstanceId: "reqloop_default",
        message: {
          text: "Connector ready",
          tone: "success",
        },
      },
    ]);
    expect(Object.isFrozen(toasts[0])).toBe(true);
    expect(Object.isFrozen(toasts[0]!.message)).toBe(true);
    const created = context!.resources.create(REQ_LOOP_RUN, {
      name: "run_labeled",
      labels: { "reqloop.baton.dev/source": "test" },
      annotations: { "example.com/display-name": "Labeled run" },
      spec: { requirement: "labeled" },
    });
    expect(created.metadata.labels).toEqual({
      "reqloop.baton.dev/source": "test",
    });
    expect(created.metadata.annotations).toEqual({
      "example.com/display-name": "Labeled run",
    });
    expect(Object.isFrozen(created.metadata.labels)).toBe(true);
    expect(Object.isFrozen(created.metadata.annotations)).toBe(true);
    const resource = context!.resources.get<
      { requirement: string },
      { phase: string }
    >(REQ_LOOP_RUN, "run_1");
    expect(Object.isFrozen(resource)).toBe(true);
    const updated = context!.resources.patchStatus(resource, {
      phase: "running",
    });
    expect(updated.status.phase).toBe("running");
    expect(() =>
      context!.resources.patchStatus(foreign, { phase: "forbidden" }),
    ).toThrow("outside reqloop_default");
    expect(() =>
      context!.resources.create(BATON_TURN_RESOURCE_TYPE, {
        name: "forged_turn",
        spec: {},
      }),
    ).toThrow("Resource type is reserved by Baton");
    await manager.close();
  });

  test("writes Plugin diagnostics to the owning BatonSession log", async () => {
    const root = testRoot();
    const session = new SessionStore(root).createSession({ cwd: root });
    const instances = new PluginInstanceStore({ session });
    const proposals = new ProposalStore({ session });
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const manager = new Manager({
      session,
      instances,
      proposals,
      packages: [reqloopPackage((activation) => {
        activation.logger.write({
          level: "warn",
          component: "devloop.pull-request-source",
          message: "Could not parse devloop PR state",
          error: new SyntaxError("Unexpected end of JSON input"),
          details: { path: "/repo/.devloop/pr.json" },
        });
      })],
      onProposal() {},
    });

    await manager.start();

    const log = JSON.parse(
      readFileSync(join(session.dir, "session.log"), "utf8").trim(),
    );
    expect(log).toMatchObject({
      batonSessionId: session.id,
      level: "warn",
      component:
        "plugin.qiankun/reqloop.devloop.pull-request-source",
      message: "Could not parse devloop PR state",
      error: {
        name: "SyntaxError",
        message: "Unexpected end of JSON input",
      },
      details: {
        path: "/repo/.devloop/pr.json",
        pluginId: "qiankun/reqloop",
        pluginInstanceId: "reqloop_default",
        packageVersion: "1.2.0",
      },
    });
    expect(session.readEvents()).toEqual([]);

    await manager.close();
  });

  test("restores enabled instances and scopes Resource registration to each instance", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    for (const pluginInstanceId of ["reqloop_a", "reqloop_b"]) {
      instances.create({
        pluginInstanceId,
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      });
      resourceStore(root, pluginInstanceId).create({
        type: REQ_LOOP_RUN,
        name: "run_1",
        spec: { requirement: pluginInstanceId },
      });
    }
    instances.create({
      pluginInstanceId: "reqloop_disabled",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      enabled: false,
    });
    const activated: string[] = [];
    const reconciled: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          activated.push(context.instance.pluginInstanceId);
          context.registerController({
            resourceType: REQ_LOOP_RUN,
            async reconcile(_baton, resource) {
                reconciled.push(resource.metadata.namespace);
              },
          });
        }),
      ],
      onProposal() {},
    });

    await manager.start();
    expect(activated).toEqual(["reqloop_a", "reqloop_b"]);
    expect(manager.isInstanceActive("reqloop_a")).toBe(true);
    expect(manager.isInstanceActive("reqloop_b")).toBe(true);
    expect(manager.isInstanceActive("reqloop_disabled")).toBe(false);
    await waitFor(() => reconciled.length === 2);
    expect(reconciled.sort()).toEqual(["reqloop_a", "reqloop_b"]);
    await manager.close();
  });

  test("keeps one owner for each Plugin-defined Resource kind", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "first",
      pluginId: "example/first",
      packageVersion: "1.0.0",
    });
    instances.create({
      pluginInstanceId: "second",
      pluginId: "example/second",
      packageVersion: "1.0.0",
    });
    const controllerPackage = (pluginId: string): PluginPackage => ({
      pluginId,
      version: "1.0.0",
      activate(context) {
        context.registerController({
          resourceType: resourceType("SharedRun"),
          async reconcile() {},
        });
      },
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        controllerPackage("example/first"),
        controllerPackage("example/second"),
      ],
      onProposal() {},
    });

    await manager.activateInstance("first");
    await expect(manager.activateInstance("second")).rejects.toThrow(
      "is already registered by example/first",
    );
    await manager.close();
  });

  test("deactivation closes registrations and custom cleanup in reverse order", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const closed: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.onClose(() => {
            closed.push("connector");
          });
          context.registerController({
            resourceType: REQ_LOOP_RUN,
            async reconcile() {},
          });
          context.onClose(() => {
            closed.push("subscription");
          });
        }),
      ],
      onProposal() {},
    });

    await manager.activateInstance("reqloop_default");
    await manager.deactivateInstance("reqloop_default");
    await manager.deactivateInstance("reqloop_default");

    expect(closed).toEqual(["subscription", "connector"]);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "no plugin Controller registered",
    );
    await manager.close();
  });

  test("rolls back a partially activated Binding", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const closed: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.onClose(() => {
            closed.push("connector");
          });
          context.registerController({
            resourceType: REQ_LOOP_RUN,
            async reconcile() {},
          });
          throw new Error("activation failed");
        }),
      ],
      onProposal() {},
    });

    await expect(manager.activateInstance("reqloop_default")).rejects.toThrow(
      "activation failed",
    );
    expect(closed).toEqual(["connector"]);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "no plugin Controller registered",
    );
    await manager.close();
  });

  test("rejects disabled or unavailable package versions", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "disabled",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      enabled: false,
    });
    instances.create({
      pluginInstanceId: "missing",
      pluginId: "qiankun/reqloop",
      packageVersion: "2.0.0",
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [reqloopPackage(() => {})],
      onProposal() {},
    });

    await expect(manager.activateInstance("disabled")).rejects.toThrow(
      "plugin Instance is disabled: disabled",
    );
    await expect(manager.activateInstance("missing")).rejects.toThrow(
      "plugin Package is unavailable: qiankun/reqloop@2.0.0",
    );
    await manager.close();
  });

  test("seals activation and rejects duplicate Package identities", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let captured: PluginActivationContext | undefined;
    const plugin = reqloopPackage((context) => {
      captured = context;
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [plugin],
      onProposal() {},
    });
    await manager.activateInstance("reqloop_default");

    expect(() =>
      captured?.registerController({
        resourceType: resourceType("LateResource"),
        async reconcile() {},
      }),
    ).toThrow("plugin Binding activation is complete");
    expect(
      () =>
        new Manager({
          instances,
          proposals,
          packages: [plugin, plugin],
          onProposal() {},
        }),
    ).toThrow("plugin Package already registered: qiankun/reqloop@1.2.0");
    await manager.close();
  });

  test("Manager close is idempotent and tears down active Bindings", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let cleanups = 0;
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.onClose(() => {
            cleanups += 1;
          });
          context.registerController({
            resourceType: REQ_LOOP_RUN,
            async reconcile() {},
          });
        }),
      ],
      onProposal() {},
    });
    await manager.start();

    await manager.close();
    await manager.close();

    expect(cleanups).toBe(1);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "plugin Manager is closed",
    );
    await expect(manager.start()).rejects.toThrow("plugin Manager is closed");
  });

  test("requires Instance and Proposal stores to own the same BatonSession", () => {
    const root = testRoot();
    const { proposals } = stores(root);
    const instances = new PluginInstanceStore({
      session: {
        id: "bs_other",
        dir: join(root, "projects", "project", "sessions", "bs_other"),
      },
    });

    expect(
      () =>
        new Manager({
          instances,
          proposals,
          onProposal() {},
        }),
    ).toThrow("plugin InstanceStore and ProposalStore must own the same BatonSession");
  });

  test("startup isolates one Instance activation failure from other Plugins", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    for (const pluginInstanceId of ["broken", "healthy"]) {
      instances.create({
        pluginInstanceId,
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      });
    }
    const failures: Array<{ pluginInstanceId: string; error: unknown }> = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          if (context.instance.pluginInstanceId === "broken") {
            throw new Error("connector config is invalid");
          }
          context.registerController({
            resourceType: REQ_LOOP_RUN,
            async reconcile() {},
          });
        }),
      ],
      onProposal() {},
      onActivationError(failure) {
        failures.push(failure);
      },
    });

    await manager.start();

    expect(manager.isInstanceActive("broken")).toBe(false);
    expect(manager.isInstanceActive("healthy")).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pluginInstanceId).toBe("broken");
    expect((failures[0]?.error as Error).message).toBe("connector config is invalid");
    await manager.close();
  });

  test("loads persisted Package versions lazily and restores enabled Instances", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let loads = 0;
    const manager = new Manager({
      instances,
      proposals,
      async loadPackage(pluginId, version) {
        loads += 1;
        expect([pluginId, version]).toEqual(["qiankun/reqloop", "1.2.0"]);
        return reqloopPackage(() => {});
      },
      onProposal() {},
    });

    await manager.start();

    expect(loads).toBe(1);
    expect(manager.isInstanceActive("reqloop_default")).toBe(true);
    await manager.close();
  });

  test("creates, disables, and restores a session-scoped Instance through Manager", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    let activations = 0;
    let cleanups = 0;
    const loadPackage = async () =>
      reqloopPackage((context) => {
        activations += 1;
        context.onClose(() => {
          cleanups += 1;
        });
      });
    const manager = new Manager({
      instances,
      proposals,
      loadPackage,
      onProposal() {},
    });

    const created = await manager.createInstance({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    expect(created.enabled).toBe(true);
    expect(manager.isInstanceActive(created.pluginInstanceId)).toBe(true);

    const disabled = await manager.setInstanceEnabled(created.pluginInstanceId, false);
    expect(disabled.enabled).toBe(false);
    expect(manager.isInstanceActive(created.pluginInstanceId)).toBe(false);
    expect(cleanups).toBe(1);
    await manager.close();

    const restored = new Manager({
      instances,
      proposals,
      loadPackage,
      onProposal() {},
    });
    await restored.start();
    expect(activations).toBe(1);
    expect(restored.isInstanceActive(created.pluginInstanceId)).toBe(false);
    await restored.close();
  });

  test("updates an Instance Package while preserving identity, config, and enabled state", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      config: { project: "baton" },
    });
    const activated: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage(() => {
          activated.push("1.2.0");
        }),
        reqloopPackage(() => {
          activated.push("1.3.0");
        }, "1.3.0"),
      ],
      onProposal() {},
    });
    await manager.start();

    const updated = await manager.setInstancePackageVersion(
      "reqloop_default",
      "1.3.0",
    );

    expect(updated).toMatchObject({
      pluginInstanceId: "reqloop_default",
      packageVersion: "1.3.0",
      enabled: true,
      config: { project: "baton" },
    });
    expect(manager.isInstanceActive("reqloop_default")).toBe(true);
    expect(activated).toEqual(["1.2.0", "1.3.0"]);
    await manager.close();
  });

  test("restores the previous Package when updated activation fails", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage(() => {}),
        reqloopPackage(() => {
          throw new Error("new Package failed");
        }, "1.3.0"),
      ],
      onProposal() {},
    });
    await manager.start();

    await expect(
      manager.setInstancePackageVersion("reqloop_default", "1.3.0"),
    ).rejects.toThrow("new Package failed");
    expect(instances.get("reqloop_default").packageVersion).toBe("1.2.0");
    expect(manager.isInstanceActive("reqloop_default")).toBe(true);
    await manager.close();
  });

  test("fresh reloads each Package once and isolates activation failures", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    for (const pluginInstanceId of ["reqloop_a", "reqloop_b"]) {
      instances.create({
        pluginInstanceId,
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      });
    }
    const loads: Array<boolean | undefined> = [];
    let generation = 0;
    const manager = new Manager({
      instances,
      proposals,
      async loadPackage(_pluginId, _version, options) {
        loads.push(options?.fresh);
        generation += 1;
        const currentGeneration = generation;
        return reqloopPackage((context) => {
          if (
            currentGeneration === 2 &&
            context.instance.pluginInstanceId === "reqloop_a"
          ) {
            throw new Error("fresh activation failed");
          }
        });
      },
      onProposal() {},
    });
    await manager.start();

    const result = await manager.reload();

    expect(loads).toEqual([undefined, true]);
    expect(result.activated).toEqual(["reqloop_b"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.pluginInstanceId).toBe("reqloop_a");
    expect(manager.isInstanceActive("reqloop_a")).toBe(false);
    expect(manager.isInstanceActive("reqloop_b")).toBe(true);
    expect(instances.get("reqloop_a").enabled).toBe(true);
    await manager.close();
  });

  test("rolls explicit enable failure back to disabled", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    const manager = new Manager({
      instances,
      proposals,
      async loadPackage() {
        return {
          pluginId: "wrong/plugin",
          version: "1.2.0",
          activate() {},
        };
      },
      onProposal() {},
    });

    await expect(
      manager.createInstance({
        pluginInstanceId: "reqloop_default",
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      }),
    ).rejects.toThrow(
      "loaded Package identity wrong/plugin@1.2.0 does not match qiankun/reqloop@1.2.0",
    );
    expect(instances.get("reqloop_default").enabled).toBe(false);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await manager.close();
  });
});
