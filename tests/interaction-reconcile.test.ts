import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReconcileInteractionStore } from "../src/interaction/reconcile.ts";
import type { ExecutionScope } from "../src/plugin/verb.ts";
import { SessionStore } from "../src/store/store.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-interaction-"));
  roots.push(root);
  return new SessionStore(root).createSession({ cwd: "/repo" });
}

function scope(batonSessionId: string, executionId = "pex_1"): ExecutionScope {
  return {
    batonSessionId,
    pluginInstanceId: "reqloop_default",
    executionId,
  };
}

function latestInteraction(handle: ReturnType<typeof session>) {
  return [...handle.loadState().interactions.values()].at(-1)!.interaction;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ReconcileInteractionStore", () => {
  test("awaits an answer and correlates it with the live execution", async () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const context = scope(handle.id);
    const result = store.ask(context, {
      title: "Associate pull request",
      prompt: "Choose a requirement",
      timeoutMs: 1_000,
      choices: [{ value: "req_1", label: "REQ-1" }],
    });
    const interaction = latestInteraction(handle);

    expect(interaction.pluginContext).toEqual({
      executionId: context.executionId,
      verb: "ask",
    });
    expect(store.complete(interaction.interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["req_1"] },
    })).toBe(true);
    await expect(result).resolves.toEqual({
      state: "success",
      value: "req_1",
    });
    store.close();
  });

  test("distinguishes Esc dismissal, timeout, and execution failure", async () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);

    const dismissed = store.ask(scope(handle.id, "pex_dismiss"), {
      title: "Approve",
      prompt: "Continue?",
      timeoutMs: 1_000,
      allowOther: true,
    });
    expect(store.complete(latestInteraction(handle).interactionId, {
      kind: "cancelled",
      reason: "user",
    })).toBe(true);
    await expect(dismissed).resolves.toEqual({ state: "dismissed" });

    const timedOut = store.ask(scope(handle.id, "pex_timeout"), {
      title: "Approve",
      prompt: "Continue?",
      timeoutMs: 10,
      allowOther: true,
    });
    const timedOutId = latestInteraction(handle).interactionId;
    await expect(timedOut).resolves.toEqual({ state: "timeout" });
    expect(store.complete(timedOutId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["late"] },
    })).toBe(false);

    const failed = store.ask(scope(handle.id, "pex_failed"), {
      title: "Approve",
      prompt: "Continue?",
      timeoutMs: 1_000,
      allowOther: true,
    });
    store.failExecution("pex_failed", "runner exited");
    await expect(failed).resolves.toEqual({
      state: "failure",
      error: "runner exited",
    });
    store.close();
  });

  test("treats a negative confirmation as a successful business value", async () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const result = store.confirm(scope(handle.id), {
      title: "Close requirement",
      prompt: "Close it?",
      timeoutMs: 1_000,
    });
    expect(store.complete(latestInteraction(handle).interactionId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["decline"] },
    })).toBe(true);
    await expect(result).resolves.toEqual({
      state: "success",
      value: "declined",
    });
    store.close();
  });

  test("awaits draft submission and exposes an explicit draft dismissal", async () => {
    const handle = session();
    const store = new ReconcileInteractionStore(handle);
    const submitted = store.draft(scope(handle.id, "pex_submit"), {
      title: "Implement",
      prompt: "Implement the focused fix.",
      timeoutMs: 1_000,
    });
    expect(store.complete(latestInteraction(handle).interactionId, {
      kind: "suggested_input",
      outcome: "submitted",
      blocks: [{ type: "text", text: "Implement only src/a.ts." }],
    })).toBe(true);
    await expect(submitted).resolves.toEqual({
      state: "success",
      value: { blocks: [{ type: "text", text: "Implement only src/a.ts." }] },
    });

    const dismissed = store.draft(scope(handle.id, "pex_dismiss"), {
      title: "Implement",
      prompt: "Implement the focused fix.",
      timeoutMs: 1_000,
    });
    expect(store.complete(latestInteraction(handle).interactionId, {
      kind: "suggested_input",
      outcome: "dismissed",
    })).toBe(true);
    await expect(dismissed).resolves.toEqual({ state: "dismissed" });
    store.close();
  });

  test("always records the harness gate before auto or user approval", async () => {
    const autoHandle = session();
    const autoStore = new ReconcileInteractionStore(autoHandle);
    await expect(autoStore.harness(scope(autoHandle.id), {
      title: "Implement",
      prompt: "Implement the focused fix.",
      timeoutMs: 1_000,
      laneId: "main",
    })).resolves.toEqual({ state: "success", value: "approved" });
    expect(autoHandle.ledger.read().filter((event) =>
      event.kind === "interaction.requested" ||
      event.kind === "interaction.answered"
    ).map((event) => event.kind)).toEqual([
      "interaction.requested",
      "interaction.answered",
    ]);
    autoStore.close();

    const manualHandle = session();
    const manualStore = new ReconcileInteractionStore(manualHandle, {
      harnessInvocationGate: () => "require_user",
    });
    const declined = manualStore.harness(scope(manualHandle.id), {
      title: "Implement",
      prompt: "Implement the focused fix.",
      timeoutMs: 1_000,
      laneId: "main",
    });
    expect(manualStore.complete(latestInteraction(manualHandle).interactionId, {
      kind: "harness_invocation",
      outcome: "declined",
    })).toBe(true);
    await expect(declined).resolves.toEqual({
      state: "success",
      value: "declined",
    });
    manualStore.close();
  });
});
