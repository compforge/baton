import { describe, expect, test } from "bun:test";

import {
  desiredPluginBinding,
  PluginHost,
  type PluginBindingDefinition,
  type PluginHostPackage,
} from "../src/plugin/host.ts";

function plugin(): PluginHostPackage {
  return {
    pluginId: "compforge/reqloop",
    marketplace: "reqloop",
    packageVersion: "1.0.0",
    config: {},
  };
}

describe("Plugin Host", () => {
  test("derives one stable Binding from one enabled PluginInstance", () => {
    const first = desiredPluginBinding(plugin());
    const second = desiredPluginBinding(plugin());

    expect(first.bindingId).toBe(second.bindingId);
    expect(first).toMatchObject(plugin());
  });

  test("keeps one Worker regardless of Session activity", async () => {
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

    await host.reconcile([plugin()]);
    await host.reconcile([plugin()]);
    expect(started).toHaveLength(1);
    expect(host.list()).toMatchObject([{
      pluginId: "compforge/reqloop",
      phase: "running",
      pid: 123,
    }]);

    await host.close();
    expect(stopped).toHaveLength(1);
  });

  test("restarts only the Binding whose immutable input changed", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const host = new PluginHost({
      async launch(binding) {
        started.push(binding.packageVersion);
        return {
          async close() {
            stopped.push(binding.packageVersion);
          },
        };
      },
    });
    await host.reconcile([plugin()]);
    await host.reconcile([{ ...plugin(), packageVersion: "1.1.0" }]);

    expect(started).toEqual(["1.0.0", "1.1.0"]);
    expect(stopped).toEqual(["1.0.0"]);
    await host.close();
  });

  test("does not retry a failed Binding on an unchanged reconcile", async () => {
    let starts = 0;
    const host = new PluginHost({
      async launch() {
        starts += 1;
        throw new Error("activation failed");
      },
    });
    await host.reconcile([plugin()]);
    await host.reconcile([plugin()]);

    expect(starts).toBe(1);
    expect(host.list()[0]).toMatchObject({
      phase: "failed",
      error: "activation failed",
    });
    await host.close();
  });
});
