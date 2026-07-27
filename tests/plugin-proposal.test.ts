import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileProposal } from "../src/plugin/controller.ts";
import { BATON_TURN_RESOURCE_TYPE } from "../src/plugin/package.ts";
import { ProposalStore } from "../src/plugin/proposal.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-proposal-"));
  roots.push(root);
  return root;
}

function draft(
  text: string = "Review requirement",
  basedOnGeneration: number = 1,
): ReconcileProposal {
  return {
    key: {
      batonSessionId: "bs_test",
      pluginInstanceId: "reqloop_default",
      resourceApiVersion: "reqloop.baton.dev/v1alpha1",
      resourceKind: "ReqLoopRun",
      resourceId: "run_1",
    },
    basedOnGeneration,
    text,
  };
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ProposalStore", () => {
  test("gives the same Resource generation and text one durable identity", () => {
    const root = testRoot();
    const firstStore = new ProposalStore({
      session: testSession(root),
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });
    const first = firstStore.record(draft());
    const reopened = new ProposalStore({
      session: testSession(root),
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    expect(first.proposalId).toMatch(/^pp_[0-9a-f]{64}$/);
    expect(reopened.record(draft())).toEqual(first);
    expect(reopened.record(draft("Review the revised requirement")).proposalId).not.toBe(
      first.proposalId,
    );
    expect(reopened.record(draft("Review requirement", 2)).proposalId).not.toBe(
      first.proposalId,
    );
    expect(
      existsSync(
        join(
          root,
          "projects",
          "project",
          "sessions",
          "bs_test",
          "plugins",
          "reqloop_default",
          "proposals",
          `${first.proposalId}.json`,
        ),
      ),
    ).toBe(true);
  });

  test("distinguishes observations within one Resource generation by resourceVersion", () => {
    const store = new ProposalStore({
      session: testSession(testRoot()),
    });
    const observedDraft = (resourceVersion: string): ReconcileProposal => ({
      key: draft().key,
      basedOnGeneration: 1,
      basedOnResourceVersion: resourceVersion,
      text: "Review requirement",
    });
    const first = store.record(observedDraft("2"));
    const repeated = store.record(observedDraft("2"));
    const nextObservation = store.record(observedDraft("3"));

    expect(repeated).toEqual(first);
    expect(nextObservation.proposalId).not.toBe(first.proposalId);
  });

  test("persists the first resolution and derives pending from its absence", () => {
    const root = testRoot();
    const proposals = new ProposalStore({
      session: testSession(root),
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });
    const dismissed = proposals.record(draft());
    const pending = proposals.record(draft("Fix review findings", 2));

    expect(
      proposals
        .listPending()
        .map((proposal) => proposal.proposalId)
        .sort(),
    ).toEqual([dismissed.proposalId, pending.proposalId].sort());
    const resolved = proposals.resolve(dismissed.proposalId, "dismissed");
    expect(resolved.resolution).toEqual({
      outcome: "dismissed",
      resolvedAt: "2026-07-25T00:00:00.000Z",
    });
    expect(proposals.resolve(dismissed.proposalId, "submitted")).toEqual(resolved);
    expect(proposals.record(draft())).toEqual(resolved);
    expect(proposals.listPending()).toEqual([pending]);
  });

  test("rejects proposals outside its BatonSession and unsafe identities", () => {
    const root = testRoot();
    const proposals = new ProposalStore({
      session: testSession(root),
    });

    expect(() =>
      proposals.record({
        ...draft(),
        key: { ...draft().key, batonSessionId: "bs_another" },
      }),
    ).toThrow("plugin proposal batonSessionId must be bs_test, got bs_another");
    expect(() =>
      proposals.record({
        ...draft(),
        key: { ...draft().key, pluginInstanceId: "../escape" },
      }),
    ).toThrow("pluginInstanceId");
    expect(() => proposals.get("not-a-proposal")).toThrow("invalid plugin proposal id");
  });

  test("persists Builtin Resource proposals against ledger revision", () => {
    const root = testRoot();
    const firstStore = new ProposalStore({
      session: testSession(root),
      now: () => new Date("2026-07-25T00:00:00.000Z"),
    });
    const draft: ReconcileProposal = {
      key: {
        batonSessionId: "bs_test",
        pluginInstanceId: "router_default",
        resourceOwner: "baton",
        resourceApiVersion: BATON_TURN_RESOURCE_TYPE.apiVersion,
        resourceKind: BATON_TURN_RESOURCE_TYPE.kind,
        resourceId: "t_1",
      },
      basedOnRevision: 42,
      text: "Use Codex for this turn.",
    };
    const first = firstStore.record(draft);
    const reopened = new ProposalStore({
      session: testSession(root),
      now: () => new Date("2026-07-26T00:00:00.000Z"),
    });

    expect(first.basedOnRevision).toBe(42);
    expect(reopened.record(draft)).toEqual(first);
    expect(
      reopened.record({
        key: draft.key,
        basedOnRevision: 43,
        text: draft.text,
      }).proposalId,
    ).not.toBe(first.proposalId);
  });

});
