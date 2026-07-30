import { describe, expect, test } from "bun:test";

import { claudeTranscript } from "../src/harness/claude/native-session.ts";
import {
  forkCodexSession,
  inspectCodexSession,
} from "../src/harness/codex/native-session.ts";

describe("Codex native sessions", () => {
  test("inspect is read-only and paginates the complete turn history", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const peer = {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === "thread/read") {
          return {
            thread: {
              id: "thread-1",
              cwd: "/repo",
              name: "Fix cache",
              preview: "fallback",
            },
          };
        }
        const cursor = (params as { cursor?: string }).cursor;
        return cursor
          ? {
              data: [
                {
                  items: [
                    { type: "userMessage", content: [{ type: "text", text: "old question" }] },
                  ],
                },
              ],
              nextCursor: null,
            }
          : {
              // app-server returns desc; provider restores chronological order after all pages.
              data: [
                {
                  items: [
                    { type: "userMessage", content: [{ type: "text", text: "new question" }] },
                    { type: "agentMessage", text: "new answer" },
                  ],
                },
              ],
              nextCursor: "older",
            };
      },
    };

    expect(await inspectCodexSession(peer, "thread-1")).toEqual({
      nativeSessionId: "thread-1",
      cwd: "/repo",
      title: "Fix cache",
      transcript: [
        { role: "user", text: "old question" },
        { role: "user", text: "new question" },
        { role: "assistant", text: "new answer" },
      ],
    });
    expect(calls).toEqual([
      { method: "thread/read", params: { threadId: "thread-1" } },
      {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 50,
          sortDirection: "desc",
          itemsView: "summary",
        },
      },
      {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 50,
          sortDirection: "desc",
          itemsView: "summary",
          cursor: "older",
        },
      },
    ]);
  });

  test("inspect maps a missing thread to no match", async () => {
    const peer = {
      async request() {
        throw new Error("rpc error: thread not found");
      },
    };
    expect(await inspectCodexSession(peer, "missing")).toBeNull();
  });

  test("fork uses Codex native thread/fork without returning unbounded turns", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const peer = {
      async request(method: string, params: unknown) {
        calls.push({ method, params });
        return { thread: { id: "thread-child" } };
      },
    };
    expect(await forkCodexSession(peer, "thread-source")).toBe("thread-child");
    expect(calls).toEqual([
      {
        method: "thread/fork",
        params: { threadId: "thread-source", excludeTurns: true },
      },
    ]);
  });
});

describe("Claude Code native sessions", () => {
  test("normalizes only user/assistant text from SDK history", () => {
    expect(
      claudeTranscript([
        {
          type: "user",
          uuid: "u1",
          session_id: "s1",
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { content: [{ type: "text", text: "hello" }, { type: "image" }] },
        },
        {
          type: "assistant",
          uuid: "a1",
          session_id: "s1",
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { content: [{ type: "text", text: "world" }] },
        },
        {
          type: "system",
          uuid: "sys",
          session_id: "s1",
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: "ignored",
        },
      ]),
    ).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "world" },
    ]);
  });
});
