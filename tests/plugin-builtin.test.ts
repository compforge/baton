import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BATON_TURN_RESOURCE_KIND,
  BatonResourceIndex,
} from "../src/plugin/builtin.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import { Manager } from "../src/plugin/manager.ts";
import type { PluginPackage } from "../src/plugin/package.ts";
import { BATON_TURN_RESOURCE_TYPE } from "../src/plugin/package.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

const roots: string[] = [];

function testSession(): SessionHandle {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-builtin-"));
  roots.push(root);
  return new SessionStore(root).createSession({
    cwd: join(root, "project"),
  });
}

function appendTurn(
  session: SessionHandle,
  turnId: string,
  userText: string,
) {
  return session.append({
    kind: "_baton_turn_summary",
    source: { type: "baton" },
    harness: "codex",
    harnessTargetId: "codex_default",
    turnId,
    payload: {
      turnId,
      userText,
      agentText: `answer to ${userText}`,
      toolCalls: [],
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 1_000,
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

describe("Baton Resource index", () => {
  test("indexes completed turns from ledger replay and live events as frozen Resources", () => {
    const session = testSession();
    const replayed = appendTurn(session, "t_replayed", "existing question");
    const resources = new BatonResourceIndex({ session });

    const existing = resources.get(BATON_TURN_RESOURCE_KIND, "t_replayed");
    expect(existing.metadata).toEqual({
      batonSessionId: session.id,
      resourceId: "t_replayed",
      revision: replayed.seq,
      sourceEventId: replayed.eventId,
      observedAt: replayed.ts,
    });
    expect(existing.data).toMatchObject({
      turnId: "t_replayed",
      userText: "existing question",
      harness: "codex",
      harnessTargetId: "codex_default",
    });
    expect(Object.isFrozen(existing)).toBe(true);
    expect(Object.isFrozen(existing.metadata)).toBe(true);
    expect(Object.isFrozen(existing.data)).toBe(true);

    const observed: string[] = [];
    resources.subscribe((resource) => {
      observed.push(resource.metadata.resourceId);
    });
    appendTurn(session, "t_live", "new question");

    expect(observed).toEqual(["t_live"]);
    expect(
      resources
        .list(BATON_TURN_RESOURCE_KIND)
        .map((resource) => resource.metadata.resourceId),
    ).toEqual(["t_replayed", "t_live"]);
    resources.close();
  });

  test("lets a Plugin watch turns and request editable drafts", async () => {
    const session = testSession();
    appendTurn(session, "t_existing", "which harness?");
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    const reconciled: string[] = [];
    const plugin: PluginPackage = {
      pluginId: "example/router",
      version: "1.0.0",
      async activate(context) {
        context.controllers.register<
          Record<string, never>,
          { userText?: string }
        >({
          resourceType: BATON_TURN_RESOURCE_TYPE,
          async reconcile(ctx, resource) {
            expect(Object.isFrozen(ctx)).toBe(true);
            expect(ctx.snapshot.session.batonSessionId).toBe(session.id);
            reconciled.push(resource.metadata.name);
            await ctx.verbs.draft({
              title: `Route ${resource.metadata.name}`,
              prompt: `Route: ${resource.status.userText}`,
              timeoutMs: 20,
            });
          },
        });
      },
    };
    const manager = new Manager({
      session,
      instances,
      packages: [plugin],
      snapshot: () => ({
        session: {
          batonSessionId: session.id,
          cwd: session.meta.cwd,
          runState: "idle",
          revision: session.loadState().lastSeq,
        },
        activeTurns: [],
        inputs: [],
        harnessTargets: [{ id: "codex_default", harness: "codex" }],
        pendingInteractions: [],
        turns: [],
      }),
      selectedHarnessTargetId: () => "codex_default",
      enqueueHarnessInvocation() {},
    });

    await manager.start();
    const pendingDrafts = () => [...session.loadState().interactions.values()]
      .filter(({ interaction, result }) =>
        interaction.kind === "suggested_input" && !result
      )
      .map(({ interaction }) => interaction);
    await waitFor(() => pendingDrafts().length === 1);
    expect(pendingDrafts()[0]).toMatchObject({
      requester: {
        type: "plugin",
        pluginInstanceId: "router_default",
      },
      text: "Route: which harness?",
    });
    expect(manager.listHarnessInvocations()).toEqual([]);

    appendTurn(session, "t_live", "continue with codex");
    await waitFor(() => pendingDrafts().length === 2);
    expect(reconciled).toEqual(["t_existing", "t_live"]);
    expect(pendingDrafts().map((interaction) =>
      interaction.kind === "suggested_input" ? interaction.text : ""
    )).toEqual([
      "Route: which harness?",
      "Route: continue with codex",
    ]);

    await manager.deactivateInstance("router_default");
    appendTurn(session, "t_after_close", "should not run");
    await Bun.sleep(20);
    expect(reconciled).toEqual(["t_existing", "t_live"]);
    await manager.close();
  });

  test("invalidates a cached Board when a live Baton Resource arrives", async () => {
    const session = testSession();
    appendTurn(session, "t_existing", "existing question");
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      session,
      instances,
      packages: [{
        pluginId: "example/router",
        version: "1.0.0",
        async activate(context) {
          context.controllers.register<
            Record<string, never>,
            { userText?: string }
          >({
            resourceType: BATON_TURN_RESOURCE_TYPE,
            async reconcile() {},
            async present(resource) {
              return {
                title: resource.status.userText ?? resource.metadata.name,
              };
            },
          });
        },
      }],
    });

    await manager.start();
    const existingItems = manager.listBoardItems();
    expect(existingItems.map((item) => item.title)).toEqual([
      "existing question",
    ]);
    expect(manager.listBoardItems()).toBe(existingItems);

    appendTurn(session, "t_live", "new question");
    await waitFor(() => manager.listBoardItems() !== existingItems);
    const liveItems = manager.listBoardItems();
    expect(liveItems).not.toBe(existingItems);
    expect(liveItems.map((item) => item.title)).toEqual([
      "new question",
      "existing question",
    ]);

    await manager.close();
  });

  test("rejects resource Sources for read-only Baton Resources", async () => {
    const session = testSession();
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    const failures: unknown[] = [];
    const manager = new Manager({
      session,
      instances,
      packages: [{
        pluginId: "example/router",
        version: "1.0.0",
        async activate(context) {
          context.controllers.register({
            resourceType: BATON_TURN_RESOURCE_TYPE,
            sources: [{
              type: "resource",
              sourceId: "forge-turn",
              async start() {},
            }],
            async reconcile() {},
          });
        },
      }],
      onActivationError(failure) {
        failures.push(failure.error);
      },
    });

    await manager.start();
    expect(manager.isInstanceActive("router_default")).toBe(false);
    expect(String(failures[0])).toContain(
      "resource Sources cannot materialize Baton-owned Resources",
    );
    await manager.close();
  });

  test("retries a failed Baton Resource reconcile through the shared due queue", async () => {
    const session = testSession();
    appendTurn(session, "t_retry", "retry me");
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    let runs = 0;
    const attempts: number[] = [];
    const manager = new Manager({
      session,
      instances,
      retryBackoff: { initialDelayMs: 10, maxDelayMs: 10 },
      packages: [{
        pluginId: "example/router",
        version: "1.0.0",
        async activate(context) {
          context.controllers.register({
            resourceType: BATON_TURN_RESOURCE_TYPE,
            async reconcile() {
                runs += 1;
                if (runs === 1) throw new Error("temporary failure");
              },
          });
        },
      }],
      onReconcileError(failure) {
        attempts.push(failure.attempt);
      },
    });

    await manager.start();
    await waitFor(() => runs === 2);
    expect(attempts).toEqual([1]);
    await manager.close();
  });

  test("does not run a Baton Resource Controller before its Binding activation completes", async () => {
    const session = testSession();
    appendTurn(session, "t_waiting", "wait for activation");
    const instances = new PluginInstanceStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    const registered = deferred();
    const finishActivation = deferred();
    let runs = 0;
    const manager = new Manager({
      session,
      instances,
      packages: [{
        pluginId: "example/router",
        version: "1.0.0",
        async activate(context) {
          context.controllers.register({
            resourceType: BATON_TURN_RESOURCE_TYPE,
            async reconcile() {
                runs += 1;
              },
          });
          registered.resolve();
          await finishActivation.promise;
        },
      }],
    });

    const starting = manager.start();
    await registered.promise;
    await Bun.sleep(20);
    expect(runs).toBe(0);

    finishActivation.resolve();
    await starting;
    await waitFor(() => runs === 1);
    await manager.close();
  });
});
