import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginPackage } from "../src/plugin/package.ts";
import { Manager } from "../src/plugin/manager.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";

const roots: string[] = [];

function stores() {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-command-"));
  roots.push(root);
  const session = {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
  return {
    instances: new PluginInstanceStore({ session }),
  };
}

function requirementPackage(name = "requirements"): PluginPackage {
  return {
    pluginId: "qiankun/reqloop",
    version: "1.0.0",
    async activate(context) {
      context.commands.register({
        commandId: "requirements",
        name,
        description: "Browse requirements",
        async execute(input) {
          if (input.selectedValue) {
            return {
              kind: "message",
              text: `Requirement ${input.selectedValue}`,
            };
          }
          return {
            kind: "picker",
            title: "Requirements",
            options: [{ name: "Ship command support", value: "REQ-1" }],
          };
        },
      });
    },
  };
}

function searchableRequirementPackage(): PluginPackage {
  return {
    pluginId: "qiankun/searchable-reqloop",
    version: "1.0.0",
    async activate(context) {
      context.commands.register({
        commandId: "requirements",
        name: "search-requirements",
        description: "Search requirements",
        async execute(input) {
          const query = input.searchQuery ?? input.argument;
          return {
            kind: "picker",
            title: "Requirements",
            search: {
              mode: "remote",
              query,
              placeholder: "Search requirements",
            },
            options: query === "missing"
              ? []
              : [{ name: `Result for ${query}`, value: "REQ-1" }],
          };
        },
      });
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Plugin commands", () => {
  test("register with a Binding and route picker selections back to the Plugin", async () => {
    const { instances } = stores();
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.0.0",
    });
    let changes = 0;
    const manager = new Manager({
      instances,
      packages: [requirementPackage()],
      onCommandsChanged() {
        changes += 1;
      },
    });

    await manager.start();
    expect(manager.listCommands()).toEqual([
      {
        pluginId: "qiankun/reqloop",
        commandId: "requirements",
        name: "requirements",
        description: "Browse requirements",
      },
    ]);
    expect(await manager.executeCommand("requirements", { argument: "" })).toEqual({
      kind: "picker",
      title: "Requirements",
      options: [{ name: "Ship command support", value: "REQ-1" }],
    });
    expect(
      await manager.executeCommand("requirements", {
        argument: "",
        selectedValue: "REQ-1",
      }),
    ).toEqual({
      kind: "message",
      text: "Requirement REQ-1",
    });

    await manager.deactivateInstance("reqloop_default");
    expect(manager.listCommands()).toEqual([]);
    expect(changes).toBeGreaterThanOrEqual(2);
    await manager.close();
  });

  test("rejects Plugin commands that shadow Baton commands", async () => {
    const { instances } = stores();
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      packages: [requirementPackage("status")],
      reservedCommandNames: ["status"],
    });

    await expect(
      manager.activateInstance("reqloop_default"),
    ).rejects.toThrow("plugin command name is reserved by Baton: /status");
    await manager.close();
  });

  test("routes remote search queries and permits an empty result page", async () => {
    const { instances } = stores();
    instances.create({
      pluginInstanceId: "searchable_reqloop",
      pluginId: "qiankun/searchable-reqloop",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      packages: [searchableRequirementPackage()],
    });

    await manager.start();
    expect(
      await manager.executeCommand("search-requirements", {
        argument: "",
        searchQuery: "recovery",
      }),
    ).toMatchObject({
      kind: "picker",
      search: { mode: "remote", query: "recovery" },
      options: [{ name: "Result for recovery", value: "REQ-1" }],
    });
    expect(
      await manager.executeCommand("search-requirements", {
        argument: "",
        searchQuery: "missing",
      }),
    ).toMatchObject({
      kind: "picker",
      search: { mode: "remote", query: "missing" },
      options: [],
    });
    await manager.close();
  });
});
