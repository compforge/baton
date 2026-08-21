import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HumanInboxStore } from "../src/inbox/human.ts";

const roots: string[] = [];

function store(): HumanInboxStore {
  const root = mkdtempSync(join(tmpdir(), "baton-human-inbox-"));
  roots.push(root);
  return new HumanInboxStore(root);
}

function create(
  inbox: HumanInboxStore,
  namespace: "v1" | `v1/project/${string}` | `v1/project/${string}/session/${string}`,
) {
  return inbox.create({
    namespace,
    pluginId: "compforge/reqloop",
    pluginInstanceId: "pi_reqloop",
    executionId: "pex_test",
    request: {
      verb: "confirm",
      input: {
        title: "Handle review",
        prompt: "Let an Agent handle this review?",
        timeoutMs: 60_000,
      },
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Human Inbox", () => {
  test("shows one transient notification while every project Session gets a badge", () => {
    const inbox = store();
    create(inbox, "v1/project/project-a");
    const first = inbox.deliver({ sessionId: "s1", projectId: "project-a" });
    const second = inbox.deliver({ sessionId: "s2", projectId: "project-a" });
    const foreign = inbox.deliver({ sessionId: "s3", projectId: "project-b" });

    expect(first.map(({ delivery }) => delivery)).toEqual(["transient"]);
    expect(second.map(({ delivery }) => delivery)).toEqual(["badge"]);
    expect(foreign).toEqual([]);
  });

  test("delivers a session namespace only to its target Session", () => {
    const inbox = store();
    create(inbox, "v1/project/project-a/session/s2");
    expect(inbox.deliver({ sessionId: "s1", projectId: "project-a" })).toEqual([]);
    expect(
      inbox.deliver({ sessionId: "s2", projectId: "project-a" })[0]?.delivery,
    ).toBe("direct");
  });

  test("lets the deciding Session execute and returns the result for review", () => {
    const inbox = store();
    const action = create(inbox, "v1/project/project-a");
    inbox.claim(action.actionId, { sessionId: "s2", projectId: "project-a" });
    inbox.beginExecution(action.actionId, "s2");
    const completed = inbox.complete(
      action.actionId,
      "s2",
      { state: "success", value: "accepted" },
      { review: true },
    );

    expect(completed).toMatchObject({
      phase: "pending_review",
      claimedBySessionId: "s2",
      result: { state: "success", value: "accepted" },
    });
    expect(inbox.review(action.actionId, "s1", true)).toMatchObject({
      phase: "completed",
      review: { accepted: true, sessionId: "s1" },
    });
  });

  test("resumes the suspended Plugin execution when a Session completes the action", async () => {
    const inbox = store();
    const waiting = inbox.request({
      namespace: "v1/project/project-a",
      pluginId: "compforge/reqloop",
      pluginInstanceId: "pi_reqloop",
      executionId: "pex_waiting",
      request: {
        verb: "confirm",
        input: {
          title: "Handle review",
          prompt: "Continue?",
          timeoutMs: 60_000,
        },
      },
    });
    const action = inbox.list()[0]!;
    inbox.claim(action.actionId, { sessionId: "s1", projectId: "project-a" });
    inbox.complete(action.actionId, "s1", {
      state: "success",
      value: "confirmed",
    });

    expect(await waiting).toEqual({ state: "success", value: "confirmed" });
  });

  test("releases undecided claims but keeps interrupted execution visible", () => {
    const inbox = store();
    const pending = create(inbox, "v1");
    const executing = create(inbox, "v1");
    const session = { sessionId: "s1", projectId: "project-a" };
    inbox.claim(pending.actionId, session);
    inbox.claim(executing.actionId, session);
    inbox.beginExecution(executing.actionId, session.sessionId);

    inbox.releaseSession(session.sessionId);
    expect(inbox.get(pending.actionId)).toMatchObject({ phase: "pending" });
    expect(inbox.get(pending.actionId)).not.toHaveProperty("claimedBySessionId");
    expect(inbox.get(executing.actionId)).toMatchObject({
      phase: "pending_review",
      result: { state: "failure" },
    });
  });
});
