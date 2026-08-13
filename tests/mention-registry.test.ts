import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionMention } from "../src/context/mention.ts";
import { MentionRegistry } from "../src/context/registry.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function sessionStore(): SessionStore {
  const root = mkdtempSync(join(tmpdir(), "baton-mention-registry-"));
  roots.push(root);
  return new SessionStore(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("MentionRegistry", () => {
  test("registers built-in mentions with a bare namespace", async () => {
    const store = sessionStore();
    const current = store.createSession({ cwd: "/tmp", title: "current" });
    const referenced = store.createSession({
      cwd: "/tmp",
      title: "需求设计",
    });
    const mentions = new MentionRegistry();
    mentions.registerMention(
      sessionMention(store, {
        excludeSessionId: current.id,
      }),
    );

    const candidates = await mentions.candidates("需求");
    expect(candidates).toEqual([{
      group: "session",
      insert: `@session:${referenced.id}`,
      label: `@${referenced.id.slice(0, 12)}…`,
      detail: "需求设计",
    }]);
    await expect(
      mentions.resolve(`参考 ${candidates[0]!.insert}`, 1_024),
    ).resolves.toEqual([
      expect.stringContaining("Session summary: 需求设计"),
    ]);
  });

  test("qualifies Plugin namespaces and removes only their registration", async () => {
    const mentions = new MentionRegistry();
    const unregister = mentions.registerMention({
      namespace: "requirement",
      async search(query) {
        if (query && !query.toLowerCase().includes("ship")) return [];
        return [{
          id: "req_1",
          label: "Ship Mention",
          description: "Story",
        }];
      },
      async resolve(id) {
        return id === "req_1" ? "Requirement: Ship Mention" : undefined;
      },
    }, "reqloop");

    await expect(mentions.candidates("ship")).resolves.toEqual([{
      group: "reqloop@requirement",
      insert: "@reqloop.requirement:req_1",
      label: "Ship Mention",
      detail: "Story",
    }]);
    await expect(
      mentions.resolve("处理 @reqloop.requirement:req_1", 1_024),
    ).resolves.toEqual(["Requirement: Ship Mention"]);
    expect(() =>
      mentions.registerMention({
        namespace: "requirement",
        search: async () => [],
        resolve: async () => undefined,
      }, "reqloop")
    ).toThrow("Mention already registered: reqloop@requirement");

    unregister();
    await expect(mentions.candidates("ship")).resolves.toEqual([]);
  });
});
