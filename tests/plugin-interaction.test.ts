import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  test("returns level-based ask and confirm results", () => {
    const handle = session();
    const store = new PluginInteractionStore(handle);
    const context = {
      key: {
        batonSessionId: handle.id,
        pluginInstanceId: "reqloop_default",
        resourceApiVersion: "reqloop.baton.dev/v1alpha1",
        resourceKind: "Requirement",
        resourceId: "run_1",
      },
      resource: {
        apiVersion: "reqloop.baton.dev/v1alpha1",
        kind: "Requirement",
        namespace: "reqloop_default",
        name: "run_1",
        uid: "pr_resource_uid",
      },
      basedOnGeneration: 1,
      basedOnResourceVersion: "1",
    };
    const input = {
      key: "associate-pr",
      title: "Associate pull request",
      prompt: "Choose a requirement",
      choices: [{ value: "req_1", label: "REQ-1" }],
    } as const;

    expect(store.ask(context, input)).toEqual({ state: "waiting" });
    const interaction = [...handle.loadState().interactions.values()][0]
      ?.interaction;
    expect(store.complete(interaction!.interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["req_1"] },
    })).toEqual(context.key);
    expect(store.ask({
      ...context,
      basedOnResourceVersion: "2",
    }, input)).toEqual({
      state: "answered",
      value: "req_1",
    });
    expect(() => store.ask(context, {
      ...input,
      prompt: "Choose a different requirement",
    })).toThrow("plugin Interaction identity conflict");

    expect(store.confirm(context, {
      key: "close",
      title: "Close requirement",
      prompt: "Close it?",
    })).toEqual({ state: "waiting" });
    const confirmation = [...handle.loadState().interactions.values()]
      .find(({ interaction: candidate }) =>
        candidate.interactionId !== interaction?.interactionId
      )?.interaction;
    store.complete(confirmation!.interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["grant"] },
    });
    expect(store.confirm(context, {
      key: "close",
      title: "Close requirement",
      prompt: "Close it?",
    })).toEqual({ state: "granted" });
    store.close();
  });

});
