import { describe, expect, test } from "bun:test";

import {
  claudeNativeTurns,
  claudeTranscript,
} from "../src/harness/claude/native-session.ts";
import {
  codexNativeTurns,
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
                  id: "turn-old",
                  itemsView: "full",
                  status: "completed",
                  items: [
                    { type: "userMessage", id: "u-old", content: [{ type: "text", text: "old question" }] },
                  ],
                },
              ],
              nextCursor: null,
            }
          : {
              // app-server returns desc; provider restores chronological order after all pages.
              data: [
                {
                  id: "turn-new",
                  itemsView: "full",
                  status: "completed",
                  items: [
                    { type: "userMessage", id: "u-new", content: [{ type: "text", text: "new question" }] },
                    { type: "agentMessage", id: "a-new", text: "new answer" },
                  ],
                },
              ],
              nextCursor: "older",
            };
      },
    };

    const inspected = await inspectCodexSession(peer, "thread-1");
    expect(inspected).toMatchObject({
      nativeSessionId: "thread-1",
      cwd: "/repo",
      title: "Fix cache",
      turns: [
        { userText: "old question", agentText: undefined },
        { userText: "new question", agentText: "new answer" },
      ],
    });
    expect(inspected?.turns?.map((turn) => turn.events?.map((entry) => entry.event.kind))).toEqual([
      ["user_message", "state_update", "state_update"],
      ["user_message", "state_update", "agent_message", "state_update"],
    ]);
    expect(calls).toEqual([
      { method: "thread/read", params: { threadId: "thread-1" } },
      {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 50,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
      {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 50,
          sortDirection: "desc",
          itemsView: "full",
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

  test("full turns preserve durable reasoning, tools, plan proposals, and terminal state", () => {
    const [turn] = codexNativeTurns([
      {
        id: "turn-1",
        itemsView: "full",
        status: "failed",
        error: { message: "model failed", codexErrorInfo: "server_error" },
        items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "inspect it" }] },
          { type: "reasoning", id: "r1", summary: ["Checking the call path"] },
          {
            type: "commandExecution",
            id: "cmd1",
            status: "completed",
            command: "rg cache",
            aggregatedOutput: "src/cache.ts\n",
          },
          { type: "plan", id: "plan1", text: "Fix the cache key" },
          { type: "agentMessage", id: "a1", text: "The cache key is missing the tenant." },
        ],
      },
    ]);

    expect(turn).toMatchObject({
      userText: "inspect it",
      agentText: "The cache key is missing the tenant.",
    });
    expect(turn?.events?.map((entry) => entry.event.kind)).toEqual([
      "user_message",
      "state_update",
      "agent_thought",
      "tool_call_update",
      "tool_call_update",
      "proposed_plan",
      "agent_message",
      "_baton_error_update",
      "state_update",
    ]);
    expect(turn?.events?.at(-1)?.event).toMatchObject({
      kind: "state_update",
      payload: { state: "idle", stopReason: "failed" },
    });
  });

});

describe("Claude Code native sessions", () => {
  test("keeps the text-only transcript fallback", () => {
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

  test("full turns preserve durable thinking, tools, plan proposals, and terminal state", () => {
    const [turn] = claudeNativeTurns([
      {
        type: "user",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "text",
            text: "<baton-sync>injected context</baton-sync>\n\ninspect it",
          }],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [
            { type: "thinking", thinking: "Checking the call path" },
            { type: "text", text: "I found the failing command." },
            {
              type: "tool_use",
              id: "tool-1",
              name: "Bash",
              input: { command: "rg cache" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "r1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "src/cache.ts\n",
          }],
        },
      },
      {
        type: "assistant",
        uuid: "a2",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "tool_use",
            id: "plan-1",
            name: "ExitPlanMode",
            input: { plan: "Fix the cache key" },
          }],
        },
      },
      {
        type: "user",
        uuid: "r2",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "plan-1",
            content: "Plan accepted",
          }],
        },
      },
    ]);

    expect(turn).toMatchObject({
      userText: "inspect it",
      agentText: "I found the failing command.",
    });
    expect(turn?.events?.map((entry) => entry.event.kind)).toEqual([
      "user_message",
      "state_update",
      "agent_thought",
      "agent_message",
      "tool_call_update",
      "tool_call_update",
      "tool_call_content_chunk",
      "proposed_plan",
      "state_update",
    ]);
    expect(turn?.events?.at(-1)?.event).toMatchObject({
      kind: "state_update",
      payload: { state: "idle", stopReason: "end_turn" },
    });
  });
});
