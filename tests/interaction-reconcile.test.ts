import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReconcileInteractionStore } from "../src/interaction/reconcile.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-interaction-"));
  roots.push(root);
  return new SessionStore(root).createSession({ cwd: "/repo" });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

function scope(batonSessionId: string, resourceId = "run_1") {
  return {
    key: {
      batonSessionId,
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: "reqloop.baton.dev/v1alpha1",
      resourceKind: "Requirement",
      resourceId,
    },
    resource: {
      apiVersion: "reqloop.baton.dev/v1alpha1",
      kind: "Requirement",
      namespace: "reqloop_default",
      name: resourceId,
      uid: `${resourceId}_uid`,
    },
    basedOnGeneration: 1,
    basedOnResourceVersion: "1",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ReconcileInteractionStore", () => {
  test("returns level-based ask and confirm results", () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const context = scope(handle.id);
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
      key: "associate-pr",
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
      answers: { decision: ["accept"] },
    });
    expect(store.confirm(context, {
      key: "associate-pr",
      title: "Close requirement",
      prompt: "Close it?",
    })).toEqual({ state: "accepted" });
    store.close();
  });

  test("returns arbitrary text when an ask allows answers outside its choices", () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const context = scope(handle.id);
    const input = {
      key: "execution",
      title: "Execution",
      prompt: "How should this run?",
      choices: [
        { value: "run", label: "Run" },
        { value: "edit", label: "Edit" },
      ],
      allowOther: true,
    } as const;

    expect(store.ask(context, input)).toEqual({ state: "waiting" });
    const interaction = [...handle.loadState().interactions.values()][0]
      ?.interaction;
    expect(store.complete(interaction!.interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["run after the release"] },
    })).toEqual(context.key);
    expect(store.ask(context, input)).toEqual({
      state: "answered",
      value: "run after the release",
    });
    store.close();
  });

  test("restores deadlines and durably times out an unanswered question", async () => {
    const handle = session();
    const context = scope(handle.id);
    let now = new Date("2026-08-11T12:00:00.000Z");
    let store = new ReconcileInteractionStore(handle, { now: () => now });
    const input = {
      key: "associate-pr",
      title: "Associate pull request",
      prompt: "Choose a requirement",
      allowOther: true,
      expiresAt: "2026-08-11T12:01:00.000Z",
    } as const;

    expect(store.ask(context, input)).toEqual({ state: "waiting" });
    expect(() => store.ask(context, {
      ...input,
      expiresAt: "2026-08-11T12:03:00.000Z",
    })).toThrow("plugin Interaction identity conflict");
    const interactionId = [...handle.loadState().interactions.keys()][0]!;
    store.close();

    now = new Date("2026-08-11T12:02:00.000Z");
    const timedOut: unknown[] = [];
    store = new ReconcileInteractionStore(handle, {
      now: () => now,
      onTimeout: (key) => timedOut.push(key),
    });
    await waitFor(() => timedOut.length === 1);

    expect(store.ask(context, input)).toEqual({
      state: "cancelled",
      reason: "timeout",
    });
    const cancellation = handle.readEvents().findLast((event) =>
      event.kind === "interaction.cancelled"
    );
    expect(cancellation).toMatchObject({
      source: { type: "baton" },
      payload: { reason: "timeout" },
    });
    expect(timedOut).toEqual([context.key]);
    expect(store.complete(interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["late-answer"] },
    })).toBeUndefined();
    expect(handle.loadState().interactions.get(interactionId)?.result).toEqual({
      kind: "cancelled",
      reason: "timeout",
    });
    store.close();
  });

  test("lets the requester withdraw while preserving first-terminal-wins", () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const context = scope(handle.id);
    const input = {
      key: "associate-pr",
      title: "Associate pull request",
      prompt: "Choose a requirement",
      allowOther: true,
    } as const;

    expect(store.ask(context, input)).toEqual({ state: "waiting" });
    expect(store.withdraw(context, {
      verb: "ask",
      key: input.key,
    })).toEqual({ state: "cancelled", reason: "requester" });
    expect(store.ask(context, input)).toEqual({
      state: "cancelled",
      reason: "requester",
    });
    expect(store.withdraw(context, {
      verb: "ask",
      key: input.key,
    })).toEqual({ state: "cancelled", reason: "requester" });

    const confirmation = {
      key: "close",
      title: "Close requirement",
      prompt: "Close it?",
    } as const;
    expect(store.confirm(context, confirmation)).toEqual({ state: "waiting" });
    expect(store.withdraw(context, {
      verb: "confirm",
      key: confirmation.key,
    })).toEqual({ state: "cancelled", reason: "requester" });
    expect(store.confirm(context, confirmation)).toEqual({
      state: "cancelled",
      reason: "requester",
    });

    const answeredInput = { ...input, key: "answer-first" };
    expect(store.ask(context, answeredInput)).toEqual({ state: "waiting" });
    const answered = [...handle.loadState().interactions.values()]
      .find(({ interaction }) =>
        interaction.pluginContext?.operation.verb === "ask" &&
        interaction.pluginContext.operation.key === "answer-first"
      )?.interaction;
    expect(store.complete(answered!.interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["req_1"] },
    })).toEqual(context.key);
    expect(store.withdraw(context, {
      verb: "ask",
      key: answeredInput.key,
    })).toEqual({ state: "not-pending" });
    expect(store.ask(context, answeredInput)).toEqual({
      state: "answered",
      value: "req_1",
    });
    store.close();
  });

  test("keeps draft input in Interaction until the user submits it", () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const context = scope(handle.id);
    const input = {
      key: "implement",
      prompt: "Implement run_1.",
    } as const;

    expect(store.draft(context, input)).toEqual({ state: "editing" });
    const interaction = [...handle.loadState().interactions.values()][0]
      ?.interaction;
    expect(interaction).toMatchObject({
      kind: "suggested_input",
      text: input.prompt,
    });
    expect(store.complete(interaction!.interactionId, {
      kind: "suggested_input",
      outcome: "submitted",
      blocks: [{ type: "text", text: "Implement only the focused fix." }],
    })).toEqual(context.key);
    expect(store.draft(context, input)).toEqual({
      state: "submitted",
      blocks: [{ type: "text", text: "Implement only the focused fix." }],
    });
    store.close();
  });

  test("always records the Harness gate and lets policy decide how it settles", () => {
    const autoHandle = session();
    const autoStore = new ReconcileInteractionStore(autoHandle);
    const autoContext = scope(autoHandle.id);
    const input = {
      key: "implement",
      prompt: "Implement run_1.",
      laneId: "main",
    } as const;

    expect(autoStore.harness(autoContext, input)).toEqual({ state: "approved" });
    expect(autoHandle.readEvents().filter((event) =>
      event.kind === "interaction.requested" ||
      event.kind === "interaction.answered"
    ).map((event) => event.kind)).toEqual([
      "interaction.requested",
      "interaction.answered",
    ]);
    expect([...autoHandle.loadState().interactions.values()][0]).toMatchObject({
      interaction: { kind: "harness_invocation" },
      result: { kind: "harness_invocation", outcome: "approved" },
    });
    autoStore.close();

    const manualHandle = session();
    const manualStore = new ReconcileInteractionStore(manualHandle, {
      harnessInvocationGate: () => "require_user",
    });
    const manualContext = scope(manualHandle.id);
    expect(manualStore.harness(manualContext, input)).toEqual({ state: "waiting" });
    expect(() => manualStore.harness(manualContext, {
      ...input,
      laneId: "another-lane",
    })).toThrow("plugin Interaction identity conflict");
    const interaction = [...manualHandle.loadState().interactions.values()][0]
      ?.interaction;
    expect(manualStore.complete(interaction!.interactionId, {
      kind: "harness_invocation",
      outcome: "declined",
    })).toEqual(manualContext.key);
    expect(manualStore.harness(manualContext, input)).toEqual({
      state: "declined",
    });
    manualStore.close();
  });

  test("cancels pending Interactions when their Resource incarnation is deleted", () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const context = scope(handle.id);
    const other = scope(handle.id, "run_2");
    const input = {
      key: "approve",
      title: "Approve",
      prompt: "Continue?",
      allowOther: true,
    } as const;

    store.ask(context, input);
    store.ask(other, input);
    expect(store.cancelForResource(context.resource)).toHaveLength(1);
    expect(store.ask(context, input)).toEqual({
      state: "cancelled",
      reason: "requester",
    });
    expect(store.ask(other, input)).toEqual({ state: "waiting" });
    store.close();
  });
});
