import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pluginKey } from "../src/plugin/identity.ts";
import { Manager } from "../src/plugin/manager.ts";
import type { PluginPackage } from "../src/plugin/package.ts";
import {
  GlobalPluginInstanceStore,
  PluginSettingsStore,
} from "../src/plugin/settings.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-settings-"));
  roots.push(root);
  return root;
}

function session(root: string, id: string): { id: string; dir: string } {
  return {
    id,
    dir: join(root, "projects", "project", "sessions", id),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("global plugin settings", () => {
  test("accepts a hand-written minimal plugin.yaml", () => {
    const root = testRoot();
    writeFileSync(
      join(root, "plugin.yaml"),
      `version: 1
plugins:
  "@scope/plugin@personal":
    enabled: true
    version: 1.2.3
    config: {}
`,
    );

    expect(new PluginSettingsStore(root).list()).toMatchObject([
      {
        key: "@scope/plugin@personal",
        pluginId: "@scope/plugin",
        marketplace: "personal",
        packageVersion: "1.2.3",
        enabled: true,
        config: {},
      },
    ]);
  });

  test("uses plugin@marketplace identity and projects one setting into every session", () => {
    const root = testRoot();
    const settings = new PluginSettingsStore(root);
    const first = new GlobalPluginInstanceStore({
      settings,
      session: session(root, "bs_first"),
    });
    const second = new GlobalPluginInstanceStore({
      settings,
      session: session(root, "bs_second"),
    });

    const created = first.create({
      pluginId: "qiankun/requirement-loop",
      marketplace: "reqloop",
      packageVersion: "0.1.0",
      config: { project: "baton" },
    });

    expect(pluginKey(created.pluginId, created.marketplace!)).toBe(
      "qiankun/requirement-loop@reqloop",
    );
    expect(second.list()).toEqual([
      {
        ...created,
        batonSessionId: "bs_second",
      },
    ]);
    second.setEnabled(created.pluginInstanceId, false);
    expect(first.get(created.pluginInstanceId).enabled).toBe(false);

    const yaml = readFileSync(join(root, "plugin.yaml"), "utf8");
    expect(yaml).toContain("qiankun/requirement-loop@reqloop:");
    expect(yaml).toContain("version: 0.1.0");
    expect(yaml).toContain("enabled: false");
  });

  test("new managers load global settings and reload reconciles the running session", async () => {
    const root = testRoot();
    const settings = new PluginSettingsStore(root);
    settings.set({
      pluginId: "qiankun/requirement-loop",
      marketplace: "reqloop",
      packageVersion: "0.1.0",
      enabled: true,
    });
    const activations: string[] = [];
    const plugin: PluginPackage = {
      pluginId: "qiankun/requirement-loop",
      version: "0.1.0",
      async activate(context) {
        activations.push(context.session.batonSessionId);
      },
    };
    const createManager = (id: string) => {
      const currentSession = session(root, id);
      return new Manager({
        instances: new GlobalPluginInstanceStore({
          settings,
          session: currentSession,
        }),
        loadPackage: async (pluginId, version, options) => {
          expect(pluginId).toBe(plugin.pluginId);
          expect(version).toBe(plugin.version);
          expect(options?.marketplace).toBe("reqloop");
          return plugin;
        },
      });
    };

    const first = createManager("bs_first");
    await first.start();
    const second = createManager("bs_second");
    await second.start();
    expect(activations).toEqual(["bs_first", "bs_second"]);

    const instance = first.listInstances()[0]!;
    settings.setEnabled(pluginKey(instance.pluginId, instance.marketplace!), false);
    expect((await first.reload()).activated).toEqual([]);
    expect(first.isInstanceActive(instance.pluginInstanceId)).toBe(false);

    settings.setEnabled(pluginKey(instance.pluginId, instance.marketplace!), true);
    expect((await first.reload()).activated).toEqual([instance.pluginInstanceId]);
    expect(first.isInstanceActive(instance.pluginInstanceId)).toBe(true);

    await Promise.all([first.close(), second.close()]);
  });
});
