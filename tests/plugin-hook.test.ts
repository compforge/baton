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
  options: { readonly hookTimeoutMs?: number; readonly afterHookQueueLimit?: number } = {},
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
  test("waits for all before Hooks and fails open", async () => {
    const observations: string[] = [];
    const manager = managerFor(async (context) => {
      context.hooks.register({
        hookId: "observe-input",
        stage: "human.inbound.before",
        async run(hook) {
          await Bun.sleep(10);
          observations.push(`${hook.stage}:${hook.subject.inputId}`);
        },
      });
      context.hooks.register({
        hookId: "broken-observer",
        stage: "human.inbound.before",
        run() {
          throw new Error("observer failed");
        },
      });
    });
    await manager.start();

    await expect(manager.beforeHook("human.inbound.before", {
      inputId: "in_1",
      eventId: "ev_1",
      seq: 1,
      input: { kind: "prompt", text: "implement this", harnessTargetId: "codex" },
    })).resolves.toBeUndefined();
    expect(observations).toEqual(["human.inbound.before:in_1"]);
    await manager.close();
  });

  test("times out a before Hook without blocking the caller", async () => {
    const manager = managerFor(async (context) => {
      context.hooks.register({
        hookId: "stuck-observer",
        stage: "human.inbound.before",
        async run() {
          await new Promise<void>(() => {});
        },
      });
    }, { hookTimeoutMs: 10 });
    await manager.start();

    await expect(manager.beforeHook("human.inbound.before", {
      inputId: "in_2",
      eventId: "ev_2",
      seq: 2,
      input: { kind: "prompt", text: "do not block", harnessTargetId: "codex" },
    })).resolves.toBeUndefined();
    await manager.close();
  });

  test("delivers after Hooks asynchronously through the bounded queue", async () => {
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = managerFor(async (context) => {
      context.hooks.register({
        hookId: "record-input",
        stage: "human.inbound.after",
        async run() {
          calls += 1;
          await wait;
        },
      });
    }, { afterHookQueueLimit: 1 });
    await manager.start();

    manager.afterHook("human.inbound.after", {
      inputId: "in_3",
      eventId: "ev_3",
      seq: 3,
      outcome: "succeeded",
    });
    manager.afterHook("human.inbound.after", {
      inputId: "in_4",
      eventId: "ev_4",
      seq: 4,
      outcome: "succeeded",
    });
    expect(calls).toBe(1);

    release();
    await Bun.sleep(0);
    await manager.close();
  });
});
