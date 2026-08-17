import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginPackage } from "@compforge/baton-plugin";

import { PluginInstanceStore } from "../src/plugin/instance.ts";
import { Manager } from "../src/plugin/manager.ts";

const roots: string[] = [];

function managerFor(
  activate: PluginPackage["activate"],
  options: { readonly hookTimeoutMs?: number; readonly deferredHookQueueLimit?: number } = {},
): Manager {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-hook-"));
  roots.push(root);
  const instances = new PluginInstanceStore({
    session: {
      id: "bs_hooks",
      dir: join(root, "projects", "project", "sessions", "bs_hooks"),
    },
  });
  instances.create({
    pluginInstanceId: "autopilot_default",
    pluginId: "example/autopilot",
    packageVersion: "1.0.0",
  });
  return new Manager({
    instances,
    packages: [{
      pluginId: "example/autopilot",
      version: "1.0.0",
      activate,
    }],
    ...options,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Plugin Hook runtime", () => {
  test("waits for all inline Hooks and fails open", async () => {
    const observations: string[] = [];
    const manager = managerFor(async (context) => {
      context.hooks.register({
        hookId: "observe-input",
        stage: "view.input",
        async run(hook) {
          await Bun.sleep(10);
          observations.push(`${hook.stage}:${hook.subject.inputId}`);
        },
      });
      context.hooks.register({
        hookId: "broken-observer",
        stage: "view.input",
        run() {
          throw new Error("observer failed");
        },
      });
    });
    await manager.start();

    await expect(manager.inlineHook("view.input", {
      inputId: "in_1",
      eventId: "ev_1",
      seq: 1,
      input: { kind: "prompt", text: "implement this", harnessTargetId: "codex" },
    })).resolves.toBeUndefined();
    expect(observations).toEqual(["view.input:in_1"]);
    await manager.close();
  });

  test("times out an inline Hook without blocking the caller", async () => {
    const manager = managerFor(async (context) => {
      context.hooks.register({
        hookId: "stuck-observer",
        stage: "view.input",
        async run() {
          await new Promise<void>(() => {});
        },
      });
    }, { hookTimeoutMs: 10 });
    await manager.start();

    await expect(manager.inlineHook("view.input", {
      inputId: "in_2",
      eventId: "ev_2",
      seq: 2,
      input: { kind: "prompt", text: "do not block", harnessTargetId: "codex" },
    })).resolves.toBeUndefined();
    await manager.close();
  });

  test("delivers deferred Hooks asynchronously through the bounded queue", async () => {
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = managerFor(async (context) => {
      context.hooks.register({
        hookId: "record-output",
        stage: "view.output",
        async run() {
          calls += 1;
          await wait;
        },
      });
    }, { deferredHookQueueLimit: 1 });
    await manager.start();

    manager.deferHook("view.output", {
      outputId: "vo_3",
      kind: "transcript",
      revision: 3,
    });
    manager.deferHook("view.output", {
      outputId: "vo_4",
      kind: "board",
      revision: 4,
    });
    expect(calls).toBe(1);

    release();
    await Bun.sleep(0);
    await manager.close();
  });
});
