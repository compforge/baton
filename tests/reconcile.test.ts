import { describe, expect, test } from "bun:test";

import {
  CodexAdapter,
  mapThreadStatus,
} from "../src/harness/codex/adapter.ts";
import type { OpenInteraction } from "../src/harness/adapter.ts";

const openInteraction: OpenInteraction = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

describe("Codex reconcile capability", () => {
  test("maps live thread status conservatively", () => {
    expect(mapThreadStatus({ type: "idle" })).toBe("idle");
    expect(mapThreadStatus({ type: "active" })).toBe("active");
    expect(
      mapThreadStatus({ type: "active", activeFlags: ["waitingOnApproval"] }),
    ).toBe("waiting_approval");
    expect(
      mapThreadStatus({ type: "active", activeFlags: ["waitingOnUserInput"] }),
    ).toBe("waiting_input");
    expect(mapThreadStatus({ type: "systemError" })).toBe("unknown");
    expect(mapThreadStatus(undefined)).toBe("unknown");
  });

  test("reads authoritative status without loading rollout turns", async () => {
    const calls: Array<{ method: string; params: unknown; opts: unknown }> = [];
    const peer = {
      request: async (method: string, params: unknown, opts: unknown) => {
        calls.push({ method, params, opts });
        return {
          thread: {
            status: { type: "active", activeFlags: ["waitingOnApproval"] },
          },
        };
      },
    };
    const adapter = new CodexAdapter({ openInteraction });
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);

    await expect(
      adapter.reconcile(
        { harness: "codex", handleId: "thread-1" },
        "t_1",
      ),
    ).resolves.toEqual({
      state: "waiting_approval",
      detail: "active",
    });
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: false },
        opts: { timeoutMs: 10_000 },
      },
    ]);
  });
});
