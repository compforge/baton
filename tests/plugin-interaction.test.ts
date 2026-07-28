import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileInteraction } from "../src/plugin/controller.ts";
import { Store as PluginInteractionStore } from "../src/plugin/interaction.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-interaction-"));
  roots.push(root);
  return new SessionStore(root).createSession({ cwd: "/repo" });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("plugin Interaction Store", () => {
  test("persists one decision per Resource key and restores its outcome", () => {
    const handle = session();
    const key = {
      batonSessionId: handle.id,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: "reqloop.baton.dev/v1alpha1",
      resourceKind: "Requirement",
      resourceId: "run_1",
    };
    const resource = {
      apiVersion: key.resourceApiVersion,
      kind: key.resourceKind,
      namespace: key.pluginInstanceId,
      name: key.resourceId,
      uid: "pr_resource_uid",
    } as const;
    const draft: ReconcileInteraction = {
      key,
      resource,
      basedOnGeneration: 3,
      basedOnResourceVersion: "7",
      request: {
        kind: "interaction",
        decisionKey: "associate-pr",
        title: "Associate pull request",
        prompt: "Choose a requirement",
        options: [
          { optionId: "req_1", label: "REQ-1" },
          { optionId: "reject", label: "Do not associate", role: "reject" },
        ],
      },
    };
    const store = new PluginInteractionStore(handle);

    const opened = store.open(draft);
    expect(store.open(draft).interactionId).toBe(opened.interactionId);
    expect(
      handle
        .readEvents()
        .filter((event) => event.kind === "interaction.opened"),
    ).toHaveLength(1);
    expect(
      store.resolve(opened.interactionId, {
        kind: "question",
        outcome: "answered",
        answers: { decision: ["unknown"] },
      }),
    ).toBeUndefined();
    expect(
      store.resolve(opened.interactionId, {
        kind: "question",
        outcome: "answered",
        answers: { decision: ["req_1"] },
      }),
    ).toEqual(key);
    expect(store.snapshots(key)).toEqual([
      {
        interactionId: opened.interactionId,
        decisionKey: "associate-pr",
        resource,
        outcome: { kind: "answered", values: ["req_1"] },
      },
    ]);
    store.close();

    const restored = new PluginInteractionStore(handle);
    expect(restored.snapshots(key)[0]?.outcome).toEqual({
      kind: "answered",
      values: ["req_1"],
    });
    expect(
      restored.resolve(opened.interactionId, {
        kind: "cancelled",
        reason: "user",
      }),
    ).toBeUndefined();
    restored.close();
  });

});
