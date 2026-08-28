import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  BatonSessionResource,
  BatonSessionTargetBindingResource,
  BatonTargetResource,
  PluginPackage,
} from "@compforge/baton-plugin";

import { Channel } from "../src/channel/index.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import { Manager } from "../src/plugin/manager.ts";
import {
  BATON_SESSION_RESOURCE_TYPE,
  BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE,
  BATON_TARGET_RESOURCE_TYPE,
} from "../src/plugin/package.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-core-resource-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Core Resource API", () => {
  test("lists limited Session/Target/Binding projections and persists a current-session patch", async () => {
    const store = new SessionStore(testRoot());
    const inactive = store.createSession({ cwd: "/repo-a" });
    const session = store.createSession({ cwd: "/repo-b" });
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "tests/router",
      packageVersion: "1.0.0",
    });
    const observed: {
      sessions?: readonly BatonSessionResource[];
      targets?: readonly BatonTargetResource[];
      before?: BatonSessionTargetBindingResource;
      after?: BatonSessionTargetBindingResource;
      staleError?: string;
      foreignError?: string;
      fieldError?: string;
    } = {};
    const plugin: PluginPackage = {
      pluginId: "tests/router",
      version: "1.0.0",
      async activate(context) {
        observed.sessions = await context.resources.list(
          BATON_SESSION_RESOURCE_TYPE,
        ) as readonly BatonSessionResource[];
        const targets = await context.resources.list(
          BATON_TARGET_RESOURCE_TYPE,
        ) as readonly BatonTargetResource[];
        observed.targets = targets;
        const bindings = await context.resources.list<
          BatonSessionTargetBindingResource["spec"],
          BatonSessionTargetBindingResource["status"]
        >(BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE);
        observed.before = bindings.find((binding) =>
          binding.metadata.name === session.id
        ) as BatonSessionTargetBindingResource;
        const foreign = bindings.find((binding) =>
          binding.metadata.name === inactive.id
        );
        const codex2 = targets.find((target) =>
          target.metadata.name === "codex2"
        );
        if (!observed.before || !codex2) throw new Error("missing Core Resource");
        observed.after = await context.resources.patch(observed.before, {
          type: "merge",
          value: {
            spec: {
              targetRef: {
                ...BATON_TARGET_RESOURCE_TYPE,
                namespace: codex2.metadata.namespace,
                name: codex2.metadata.name,
                uid: codex2.metadata.uid,
              },
            },
          },
        }) as BatonSessionTargetBindingResource;
        try {
          await context.resources.patch(observed.before, {
            type: "merge",
            value: { spec: { targetRef: null } },
          });
        } catch (error) {
          observed.staleError = error instanceof Error ? error.message : String(error);
        }
        if (foreign) {
          try {
            await context.resources.patch(foreign, {
              type: "merge",
              value: { spec: { targetRef: null } },
            });
          } catch (error) {
            observed.foreignError = error instanceof Error ? error.message : String(error);
          }
        }
        try {
          await context.resources.patch(observed.after, {
            type: "merge",
            value: { status: { phase: "Pending" } },
          });
        } catch (error) {
          observed.fieldError = error instanceof Error ? error.message : String(error);
        }
      },
    };
    const manager = new Manager({
      session,
      instances,
      packages: [plugin],
      harnessTargets: [
        { id: "codex", harness: "codex" },
        { id: "codex2", harness: "codex" },
        { id: "claude", harness: "claude" },
      ],
      sessions: () => [
        { meta: inactive.meta, active: false },
        { meta: session.meta, active: true },
      ],
    });

    await manager.start();

    const expectedSessions: Array<{
      name: string;
      phase: "Active" | "Inactive";
    }> = [
      { name: inactive.id, phase: "Inactive" },
      { name: session.id, phase: "Active" },
    ];
    expect(observed.sessions?.map((resource) => ({
      name: resource.metadata.name,
      phase: resource.status.phase,
    }))).toEqual(
      expectedSessions.sort((left, right) => left.name.localeCompare(right.name)),
    );
    expect(observed.targets?.map((resource) => ({
      name: resource.metadata.name,
      harness: resource.spec.harness,
    }))).toEqual([
      { name: "claude", harness: "claude" },
      { name: "codex", harness: "codex" },
      { name: "codex2", harness: "codex" },
    ]);
    expect(observed.before).toMatchObject({
      spec: { sessionRef: { name: session.id }, eligibleTargetRefs: expect.any(Array) },
      status: { phase: "Pending" },
    });
    expect(observed.after).toMatchObject({
      metadata: { generation: 2, resourceVersion: "2" },
      spec: { targetRef: { name: "codex2" } },
      status: { phase: "Bound", effectiveTargetRef: { name: "codex2" } },
    });
    expect(observed.staleError).toContain("resource version conflict");
    expect(observed.foreignError).toContain("only the current SessionTargetBinding");
    expect(observed.fieldError).toContain("only spec.targetRef");
    expect(manager.resolveHarnessTargetId("codex")).toBe("codex2");
    expect(manager.resolveHarnessTargetId("codex2")).toBe("codex2");
    expect(manager.resolveHarnessTargetId("claude")).toBe("claude");
    expect(store.openSession(session.id).meta.targetBinding).toMatchObject({
      targetId: "codex2",
      generation: 2,
      resourceVersion: 2,
    });
    await manager.close();
  });

  test("rejects a Plugin that materializes a Core-registered GVK", async () => {
    const session = new SessionStore(testRoot()).createSession({ cwd: "/repo" });
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "collision_default",
      pluginId: "tests/collision",
      packageVersion: "1.0.0",
    });
    const failures: unknown[] = [];
    const manager = new Manager({
      session,
      instances,
      packages: [{
        pluginId: "tests/collision",
        version: "1.0.0",
        async activate(context) {
          await context.resources.create(BATON_SESSION_RESOURCE_TYPE, {
            name: "forged-session",
            spec: {},
          });
        },
      }],
      onActivationError(failure) {
        failures.push(failure.error);
      },
    });

    await manager.start();

    expect(manager.isInstanceActive("collision_default")).toBe(false);
    expect(String(failures[0])).toContain("already registered by Baton");
    await manager.close();
  });

  test("applies a view.input Binding patch before routing the same prompt", async () => {
    const session = new SessionStore(testRoot()).createSession({ cwd: "/repo" });
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "hook_router_default",
      pluginId: "tests/hook-router",
      packageVersion: "1.0.0",
    });
    const plugin: PluginPackage = {
      pluginId: "tests/hook-router",
      version: "1.0.0",
      async activate(context) {
        context.hooks.register({
          hookId: "select-codex2",
          stage: "view.input",
          async run(hook) {
            if (hook.subject.input.kind !== "prompt") return;
            const binding = (await context.resources.list<
              BatonSessionTargetBindingResource["spec"],
              BatonSessionTargetBindingResource["status"]
            >(BATON_SESSION_TARGET_BINDING_RESOURCE_TYPE))[0];
            const target = (await context.resources.list<
              BatonTargetResource["spec"],
              BatonTargetResource["status"]
            >(BATON_TARGET_RESOURCE_TYPE)).find((resource) =>
              resource.metadata.name === "codex2"
            );
            if (!binding || !target) throw new Error("missing route resources");
            await context.resources.patch(binding, {
              type: "merge",
              value: {
                spec: {
                  targetRef: {
                    ...BATON_TARGET_RESOURCE_TYPE,
                    namespace: target.metadata.namespace,
                    name: target.metadata.name,
                    uid: target.metadata.uid,
                  },
                },
              },
            });
          },
        });
      },
    };
    const channel = new Channel({
      session,
      controller: {
        mentionBudgetChars: 1_000,
        createAdapter: () => {
          throw new Error("unused adapter");
        },
        resolveTarget: () => undefined,
      },
      plugins: {
        instances,
        packages: [plugin],
        harnessTargets: [
          { id: "codex", harness: "codex" },
          { id: "codex2", harness: "codex" },
        ],
      },
    });
    await channel.start();
    let routedTarget = "";
    channel.controller.sendTurn = async (targetId) => {
      routedTarget = targetId;
      return {
        effective: "new_turn",
        queued: false,
        outcome: Promise.resolve("completed"),
      };
    };

    await channel.submitPrompt({
      kind: "prompt",
      text: "route this",
      harnessTargetId: "codex",
    }, async () => [{ type: "text", text: "route this" }]);

    expect(routedTarget).toBe("codex2");
    await channel.close();
  });
});
