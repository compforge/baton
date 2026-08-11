import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { PluginInstanceStore } from "../src/plugin/instance.ts";
import { Manager, type PluginRunnerFailure } from "../src/plugin/manager.ts";
import { PluginSupervisor } from "../src/plugin/runner/index.ts";
import {
  restoredError,
  serializedError,
} from "../src/plugin/runner/protocol.ts";
import { SessionHandle } from "../src/store/store.ts";

const roots: string[] = [];

function stores() {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-runner-"));
  roots.push(root);
  const session = {
    id: "bs_runner",
    dir: join(root, "projects", "project", "sessions", "bs_runner"),
  };
  const sessionHandle = new SessionHandle(
    session.id,
    session.dir,
    {
      batonSessionId: session.id,
      cwd: root,
      createdAt: new Date().toISOString(),
      harnessTargets: {},
      lanes: {
        main: {
          laneId: "main",
          createdFor: { type: "session" },
          harnessSessions: {},
        },
      },
      harnessSessions: {},
    },
  );
  mkdirSync(session.dir, { recursive: true });
  const packageDir = join(root, "installed-package");
  const entry = join(packageDir, "index.ts");
  mkdirSync(packageDir, { recursive: true });
  // Installed Marketplace Packages have no node_modules. Type-only imports
  // must erase cleanly instead of resolving through Baton's dependency tree.
  cpSync(join(import.meta.dir, "fixtures", "process-plugin.ts"), entry);
  return {
    root,
    instances: new PluginInstanceStore({ session }),
    session: sessionHandle,
    entry,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Plugin Runner process boundary", () => {
  test("preserves nested error causes across IPC serialization", () => {
    const restored = restoredError(serializedError(
      new Error("Could not list Forge PullRequests", {
        cause: new Error("GET /repos/openai/plugins/pulls returned 404"),
      }),
    ));

    expect(restored.message).toBe("Could not list Forge PullRequests");
    expect(restored.cause).toBeInstanceOf(Error);
    expect((restored.cause as Error).message).toBe(
      "GET /repos/openai/plugins/pulls returned 404",
    );
  });

  test("routes reconcile capabilities across the process boundary", async () => {
    const { instances, session, entry } = stores();
    session.append({
      kind: "_baton_turn_summary",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex_default",
      turnId: "turn_runner",
      payload: {
        turnId: "turn_runner",
        userText: "test reconcile capabilities",
        agentText: "ready",
        toolCalls: [],
      },
    });
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          entryUrl: pathToFileURL(entry).href,
        };
      },
    });

    await manager.start();
    await waitFor(() => session.loadState().interactions.size === 1, 1_000);
    expect([...session.loadState().interactions.values()][0]).toMatchObject({
      interaction: {
        requester: {
          type: "plugin",
          pluginInstanceId: "process_default",
        },
        questions: [{
          header: "Runner question",
          question: "Review turn_runner?",
        }],
      },
    });
    await Bun.sleep(300);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    const interaction = [...session.loadState().interactions.values()][0]!
      .interaction;
    expect(await manager.completeInteraction(interaction.interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["continue"] },
    })).toBe(true);
    await waitFor(() =>
      session.loadState().interactions.get(interaction.interactionId)?.result !==
        undefined
    );

    await manager.close();
  });

  test("withdraws registrations and settles a waiting verb after a crash", async () => {
    const { root, instances, session, entry } = stores();
    session.append({
      kind: "_baton_turn_summary",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex_default",
      turnId: "turn_crash",
      payload: {
        turnId: "turn_crash",
        userText: "test crash while waiting",
        agentText: "ready",
        toolCalls: [],
      },
    });
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const activationFailures: unknown[] = [];
    const failures: PluginRunnerFailure[] = [];
    const manager = new Manager({
      instances,
      session,
      pluginSupervisor: new PluginSupervisor(),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          entryUrl: pathToFileURL(entry).href,
        };
      },
      onActivationError(failure) {
        activationFailures.push(failure.error);
      },
      onRunnerFailure(failure) {
        failures.push(failure);
      },
    });

    await manager.start();
    await waitFor(() => session.loadState().interactions.size === 1);
    await session.flushLogs();
    expect(activationFailures).toEqual([]);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    const activationLog = readFileSync(
      join(session.dir, "session.log"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.source === "plugin");
    expect(activationLog).toMatchObject({
      pluginId: "tests/process-plugin",
      pluginInstanceId: "process_default",
      packageVersion: "1.0.0",
      component: "plugin.tests/process-plugin.lifecycle",
      message: "Process Plugin activated",
      attributes: {
        capabilities: ["commands"],
        runtime: { isolated: true },
      },
    });
    await expect(
      manager.executeCommand("process-check", { argument: "data-dirs" }),
    ).resolves.toEqual({
      kind: "message",
      text: JSON.stringify({
        global: join(root, "plugins", "tests%2Fprocess-plugin"),
        project: join(
          root,
          "projects",
          "project",
          "plugins",
          "tests%2Fprocess-plugin",
        ),
        session: join(
          root,
          "projects",
          "project",
          "sessions",
          "bs_runner",
          "plugins",
          "tests%2Fprocess-plugin",
        ),
        instance: join(
          root,
          "projects",
          "project",
          "sessions",
          "bs_runner",
          "plugins",
          "tests%2Fprocess-plugin",
          "process_default",
        ),
      }),
    });
    await expect(
      manager.executeCommand("process-check", { argument: "resource-ref" }),
    ).resolves.toEqual({
      kind: "message",
      text: expect.stringMatching(
        /^\{"currentUid":"pr_[^"]+"\}$/,
      ),
    });
    const heartbeat = Bun.sleep(25).then(() => "heartbeat");
    const invocation = manager.executeCommand("process-check", {
      argument: "200",
    }).then(() => "invocation");
    expect(await Promise.race([heartbeat, invocation])).toBe("heartbeat");
    expect(await invocation).toBe("invocation");

    await expect(
      manager.executeCommand("process-check", { argument: "crash" }),
    ).rejects.toThrow(/Plugin Runner (IPC disconnected|exited unexpectedly)/);
    await waitFor(() => !manager.isInstanceActive("process_default"));
    expect(manager.listCommands()).toEqual([]);
    expect(failures).toHaveLength(1);
    expect([...session.loadState().interactions.values()][0]?.result).toMatchObject({
      kind: "cancelled",
      reason: "recovery",
    });

    await manager.close();
  });

  test("terminates a Runner whose handler exceeds its deadline", async () => {
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_timeout",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const failures: PluginRunnerFailure[] = [];
    const manager = new Manager({
      instances,
      session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          entryUrl: pathToFileURL(entry).href,
        };
      },
      onRunnerFailure(failure) {
        failures.push(failure);
      },
    });

    await manager.start();
    await expect(
      manager.executeCommand("process-check", { argument: "2000" }),
    ).rejects.toThrow(/Plugin Runner invoke timed out/);
    await waitFor(() => !manager.isInstanceActive("process_timeout"));
    expect(manager.listCommands()).toEqual([]);
    expect(failures).toHaveLength(1);

    await manager.close();
  });
});
