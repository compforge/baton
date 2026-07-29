import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionContextProvider } from "../src/context/mention.ts";
import { ContextProviderRegistry } from "../src/context/registry.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function sessionStore(): SessionStore {
  const root = mkdtempSync(join(tmpdir(), "baton-context-provider-"));
  roots.push(root);
  return new SessionStore(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ContextProviderRegistry", () => {
  test("registers built-in providers with a bare kind", async () => {
    const store = sessionStore();
    const current = store.createSession({ cwd: "/tmp", title: "current" });
    const referenced = store.createSession({
      cwd: "/tmp",
      title: "需求设计",
    });
    const context = new ContextProviderRegistry();
    context.registerContextProvider(
      sessionContextProvider(store, {
        excludeSessionId: current.id,
      }),
    );

    const candidates = await context.candidates("需求");
    expect(candidates).toEqual([{
      group: "session",
      insert: `@session:${referenced.id}`,
      label: `@${referenced.id.slice(0, 12)}…`,
      detail: "需求设计",
    }]);
    await expect(
      context.provide(`参考 ${candidates[0]!.insert}`, 1_024),
    ).resolves.toEqual([
      expect.stringContaining("Session summary: 需求设计"),
    ]);
  });

  test("qualifies Plugin kinds and removes only their registration", async () => {
    const context = new ContextProviderRegistry();
    const unregister = context.registerContextProvider({
      kind: "requirement",
      async search(query) {
        if (query && !query.toLowerCase().includes("ship")) return [];
        return [{
          id: "req_1",
          label: "Ship ContextProvider",
          detail: "Story",
        }];
      },
      async provide(id) {
        return id === "req_1" ? "Requirement: Ship ContextProvider" : undefined;
      },
    }, "reqloop");

    await expect(context.candidates("ship")).resolves.toEqual([{
      group: "reqloop@requirement",
      insert: "@reqloop.requirement:req_1",
      label: "Ship ContextProvider",
      detail: "Story",
    }]);
    await expect(
      context.provide("处理 @reqloop.requirement:req_1", 1_024),
    ).resolves.toEqual(["Requirement: Ship ContextProvider"]);
    expect(() =>
      context.registerContextProvider({
        kind: "requirement",
        search: async () => [],
        provide: async () => undefined,
      }, "reqloop")
    ).toThrow("ContextProvider already registered: reqloop@requirement");

    unregister();
    await expect(context.candidates("ship")).resolves.toEqual([]);
  });
});
