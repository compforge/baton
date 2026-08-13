// 中间过程最大公约数规范的 harness 适配测试：两家 adapter 必须把各自原生形态
// 归一成同一套事件（plan_update / diff 内容块 / tool_call_content_chunk）。
import { describe, expect, test } from "bun:test";

import {
  applyTaskOp,
  ClaudeAdapter,
  claudeApprovalOptions,
  claudeResultDiff,
  claudeToolDiff,
  claudeToolTitle,
  type TaskEntry,
  taskToolOp,
  todoWritePlan,
} from "../src/harness/claude/adapter.ts";
import { CodexAdapter } from "../src/harness/codex/adapter.ts";
import type { LogEntry } from "../src/logging.ts";
import type { AnyEventDraft } from "../src/event/index.ts";
import type { InteractionDraft } from "../src/interaction/types.ts";
import type { OpenInteraction } from "../src/harness/adapter.ts";

const openInteraction: OpenInteraction = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

function claudeHarness(): { events: AnyEventDraft[]; feed: (msg: unknown) => void } {
  const adapter = new ClaudeAdapter({ openInteraction });
  const events: AnyEventDraft[] = [];
  const rt = {
    cwd: "/tmp",
    suppressedToolIds: new Set<string>(),
    capturedProposedPlanKeys: new Set<string>(),
    claudeSessionId: "sess1",
    tasks: new Map(),
    pendingTaskOps: new Map(),
  };
  const turn = { turnId: "t1", finalized: false, cancelRequested: false };
  const feed = (msg: unknown) =>
    (
      adapter as unknown as {
        handleMessage: (r: unknown, e: (ev: AnyEventDraft) => void, m: unknown, t: unknown) => void;
      }
    ).handleMessage(rt, (ev) => events.push(ev), msg, turn);
  return { events, feed };
}

function claudeQueueHarness() {
  const adapter = new ClaudeAdapter({ openInteraction });
  const events: AnyEventDraft[] = [];
  const pendingOfferUuids = new Map([
    [
      "native-steer",
      {
        turnId: "t1",
        messageId: "m_steer",
        blocks: [{ type: "text" as const, text: "queued steer" }],
      },
    ],
  ]);
  const rt = {
    cwd: "/tmp",
    suppressedToolIds: new Set<string>(),
    capturedProposedPlanKeys: new Set<string>(),
    claudeSessionId: "sess1",
    tasks: new Map(),
    pendingTaskOps: new Map(),
    pendingOfferUuids,
  };
  const turn = { turnId: "t1", finalized: false, cancelRequested: false };
  const feed = (msg: unknown) =>
    (
      adapter as unknown as {
        handleMessage: (r: unknown, e: (ev: AnyEventDraft) => void, m: unknown, t: unknown) => void;
      }
    ).handleMessage(rt, (ev) => events.push(ev), msg, turn);
  return { events, feed, pendingOfferUuids };
}

function codexHarness(): { events: AnyEventDraft[]; notify: (method: string, params: unknown) => void } {
  const adapter = new CodexAdapter({ openInteraction });
  const events: AnyEventDraft[] = [];
  const rt = {
    threadId: "th1",
    turnId: "t1",
    activeTurn: { turnId: "t1", finalized: false, sawOutput: false },
    sink: (ev: AnyEventDraft) => events.push(ev),
  };
  const notify = (method: string, params: unknown) =>
    (adapter as unknown as { handleNotification: (r: unknown, m: string, p: unknown) => void }).handleNotification(
      rt,
      method,
      params,
    );
  return { events, notify };
}

describe("codex: error notifications", () => {
  test("projects a non-retrying error and closes the turn as failed", () => {
    const { events, notify } = codexHarness();
    const params = {
      threadId: "th1",
      turnId: "ct1",
      error: {
        message: "Your access token could not be refreshed. Please sign in again.",
        codexErrorInfo: "unauthorized",
      },
      willRetry: false,
    };

    notify("error", params);

    expect(events.map((event) => event.kind)).toEqual(["_baton_error_update", "state_update"]);
    expect(events[0]).toMatchObject({
      turnId: "t1",
      payload: {
        code: "unauthorized",
        message: "Your access token could not be refreshed. Please sign in again.",
        willRetry: false,
      },
      raw: params,
    });
    expect(events[1]).toMatchObject({
      turnId: "t1",
      payload: { state: "idle", stopReason: "failed" },
    });
  });

  test("projects a retrying error without closing the turn", () => {
    const { events, notify } = codexHarness();

    notify("error", {
      threadId: "th1",
      turnId: "ct1",
      error: { message: "stream disconnected", codexErrorInfo: "responseStreamDisconnected" },
      willRetry: true,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "_baton_error_update",
      turnId: "t1",
      payload: {
        code: "responseStreamDisconnected",
        message: "stream disconnected",
        willRetry: true,
      },
    });
  });
});

describe("codex: unmapped notifications", () => {
  test("writes a throttled diagnostic instead of entering the session timeline", () => {
    const diagnostics: LogEntry[] = [];
    const adapter = new CodexAdapter({ openInteraction, log: (entry) => diagnostics.push(entry) });
    const rt = { threadId: "th1", activeTurn: { turnId: "t1", finalized: false } };
    const notify = () =>
      (adapter as unknown as { handleNotification: (r: unknown, m: string, p: unknown) => void }).handleNotification(
        rt,
        "future/event",
        { threadId: "th1" },
      );

    notify();
    notify();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toContain("future/event");
    expect(diagnostics[0]!.attributes?.count).toBe(1);
  });
});

describe("claude: command lifecycle → steer delivery", () => {
  test("keeps queued steer pending until Claude starts the command", () => {
    const { events, feed, pendingOfferUuids } = claudeQueueHarness();

    feed({ type: "command_lifecycle", uuid: "native-steer", state: "queued" });
    expect(events).toHaveLength(0);
    expect(pendingOfferUuids.has("native-steer")).toBe(true);

    feed({ type: "command_lifecycle", uuid: "native-steer", state: "started" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "user_message",
      payload: {
        messageId: "m_steer",
        content: [{ type: "text", text: "queued steer" }],
        delivery: "steer",
        deliveryState: "applied",
      },
    });
    expect(pendingOfferUuids.has("native-steer")).toBe(false);

    // terminal frame follows started; the correlation was already consumed, so the upsert stays idempotent.
    feed({ type: "command_lifecycle", uuid: "native-steer", state: "completed" });
    expect(events).toHaveLength(1);
  });

  for (const state of ["cancelled", "discarded"] as const) {
    test(`marks ${state} steer failed without putting it in Transcript`, () => {
      const { events, feed, pendingOfferUuids } = claudeQueueHarness();

      feed({ type: "command_lifecycle", uuid: "native-steer", state });

      expect(events.map((event) => event.kind)).toEqual([
        "user_message",
        "_baton_notice",
      ]);
      expect(events[0]).toMatchObject({
        payload: { messageId: "m_steer", deliveryState: "failed" },
      });
      expect(events[1]).toMatchObject({
        payload: {
          level: "warning",
          title: "Queued message was not applied",
        },
      });
      expect(pendingOfferUuids.has("native-steer")).toBe(false);
    });
  }
});

describe("claude: TodoWrite → plan_update", () => {
  test("emits plan_update with mapped entries, no tool card", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "TodoWrite",
            input: { todos: [{ content: "步骤一", status: "completed" }, { content: "步骤二", status: "in_progress" }] },
          },
        ],
      },
    });
    const plans = events.filter((e) => e.kind === "plan_update");
    expect(plans).toHaveLength(1);
    // planId per-turn：卡片锚定在当前 turn，跨 turn 的新 plan 不改写 scrollback 里的旧卡
    expect((plans[0]!.payload as { planId: string }).planId).toBe("pl_t1");
    expect((plans[0]!.payload as { entries: unknown[] }).entries).toEqual([
      { content: "步骤一", priority: "medium", status: "completed" },
      { content: "步骤二", priority: "medium", status: "in_progress" },
    ]);
    expect(events.filter((e) => e.kind === "tool_call_update")).toHaveLength(0);

    // 对应 tool_result 也被吞掉，不会凭空造出工具卡
    feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
    expect(events.filter((e) => e.kind === "tool_call_update")).toHaveLength(0);
  });

  test("todoWritePlan tolerates unknown status", () => {
    expect(todoWritePlan({ todos: [{ content: "x", status: "weird" }] })[0]!.status).toBe("pending");
  });
});

describe("claude: ExitPlanMode → proposed_plan", () => {
  test("captures a completed proposal without creating a tool card", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu-plan",
            name: "ExitPlanMode",
            input: { plan: "# Safe rollout\n\n1. Verify\n2. Ship" },
          },
        ],
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "proposed_plan",
      payload: { content: "# Safe rollout\n\n1. Verify\n2. Ship" },
    });
    expect((events[0]!.payload as { planId: string }).planId).toMatch(/^pl_/);

    feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu-plan", content: "denied" }] },
    });
    expect(events).toHaveLength(1);
  });

  test("canUseTool deduplicates within a turn, then stops for user feedback", async () => {
    const events: AnyEventDraft[] = [];
    const interactions: InteractionDraft[] = [];
    const runtime = { capturedProposedPlanKeys: new Set<string>() };
    const adapter = new ClaudeAdapter({
      openInteraction: async (interaction) => {
        interactions.push(interaction);
        return { kind: "permission", outcome: "selected", optionId: "deny" };
      },
    });
    const handleCanUseTool = (
      adapter as unknown as {
        handleCanUseTool: (
          runtime: { capturedProposedPlanKeys: Set<string> },
          emit: (event: AnyEventDraft) => void,
          turnId: () => string,
          name: string,
          input: Record<string, unknown>,
          meta: Record<string, unknown>,
        ) => Promise<{ behavior: string; message?: string }>;
      }
    ).handleCanUseTool.bind(adapter);

    const first = await handleCanUseTool(
      runtime,
      (event) => events.push(event),
      () => "t1",
      "ExitPlanMode",
      { plan: "Implement after approval" },
      { toolUseID: "tu-plan" },
    );
    const duplicate = await handleCanUseTool(
      runtime,
      (event) => events.push(event),
      () => "t1",
      "ExitPlanMode",
      { plan: "Implement after approval" },
      { toolUseID: "tu-plan" },
    );
    await handleCanUseTool(
      runtime,
      (event) => events.push(event),
      () => "t2",
      "ExitPlanMode",
      { plan: "Implement after approval" },
      { toolUseID: "tu-plan-2" },
    );

    expect(first).toMatchObject({ behavior: "deny", message: expect.stringContaining("user feedback") });
    expect(duplicate.behavior).toBe("deny");
    expect(events.filter((event) => event.kind === "proposed_plan")).toHaveLength(2);
    expect(interactions).toEqual([]);
  });
});

describe("claude: Task 工具族 → plan_update", () => {
  const toolUse = (id: string, name: string, input: unknown) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, content: unknown, isError = false) => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  });

  test("TaskCreate/TaskUpdate settle on tool_result and project the whole table", () => {
    const { events, feed } = claudeHarness();
    feed(toolUse("tu1", "TaskCreate", { subject: "确认演示范围", description: "d" }));
    // taskId 只在结果文本里：tool_use 阶段只登记，不出工具卡也不发 plan_update
    expect(events.filter((e) => e.kind === "plan_update" || e.kind === "tool_call_update")).toHaveLength(0);

    feed(toolResult("tu1", "Task #1 created successfully: 确认演示范围"));
    let plans = events.filter((e) => e.kind === "plan_update");
    expect(plans).toHaveLength(1);
    expect((plans.at(-1)!.payload as { planId: string }).planId).toBe("pl_t1");
    expect((plans.at(-1)!.payload as { entries: unknown[] }).entries).toEqual([
      { content: "确认演示范围", priority: "medium", status: "pending" },
    ]);

    feed(toolUse("tu2", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    feed(toolResult("tu2", "Updated task #1 status"));
    plans = events.filter((e) => e.kind === "plan_update");
    expect((plans.at(-1)!.payload as { entries: unknown[] }).entries).toEqual([
      { content: "确认演示范围", priority: "medium", status: "in_progress" },
    ]);
    // 全程不出 Task 工具卡
    expect(events.filter((e) => e.kind === "tool_call_update")).toHaveLength(0);
  });

  test("TaskCreate falls back to description when subject is absent", () => {
    const { events, feed } = claudeHarness();
    feed(toolUse("tu1", "TaskCreate", { description: "删 ResolvedRepo.code_unit" }));
    feed(toolResult("tu1", "Task #1 created successfully: 删 ResolvedRepo.code_unit"));

    const plans = events.filter((e) => e.kind === "plan_update");
    expect((plans.at(-1)!.payload as { entries: unknown[] }).entries).toEqual([
      { content: "删 ResolvedRepo.code_unit", priority: "medium", status: "pending" },
    ]);
  });

  test("failed result does not touch the table; deleted removes the entry", () => {
    const tasks = new Map<string, TaskEntry>();
    applyTaskOp(tasks, { op: "create", subject: "a" }, "Task #1 created successfully: a", "fb1");
    applyTaskOp(tasks, { op: "update", taskId: "1", status: "deleted" }, "Deleted task #1", "fb2");
    expect(tasks.size).toBe(0);

    const { events, feed } = claudeHarness();
    feed(toolUse("tu1", "TaskUpdate", { taskId: "9", status: "completed" }));
    feed(toolResult("tu1", "no such task", true));
    expect(events.filter((e) => e.kind === "plan_update")).toHaveLength(0);
    // 失败不能静默：任务表不动，但要出一张 failed 工具卡让错误可感知
    const failedCards = events.filter((e) => e.kind === "tool_call_update");
    expect(failedCards).toHaveLength(1);
    expect(failedCards.at(0)!.payload).toMatchObject({
      toolCallId: "tu1",
      title: "TaskUpdate: 9",
      kind: "other",
      status: "failed",
      content: [{ type: "text", text: "no such task" }],
    });
  });

  test("applyTaskOp upserts unknown taskId and falls back when result text has no id", () => {
    const tasks = new Map<string, TaskEntry>();
    // resume 场景：任务建于 baton 观察不到的历史，update 直接 upsert
    applyTaskOp(tasks, { op: "update", taskId: "7", status: "in_progress" }, "Updated task #7 status", "fb1");
    expect(tasks.get("7")).toEqual({ subject: "Task #7", status: "in_progress" });
    // 结果文本解析不出 id 时退回 tool_use_id，任务不丢
    applyTaskOp(tasks, { op: "create", subject: "b" }, "created", "tu9");
    expect(tasks.get("tu9")).toEqual({ subject: "b", status: "pending" });
  });

  test("taskToolOp ignores read-only task tools", () => {
    expect(taskToolOp("TaskList", {})).toBeNull();
    expect(taskToolOp("TaskGet", { taskId: "1" })).toBeNull();
    expect(taskToolOp("Bash", { command: "ls" })).toBeNull();
    expect(taskToolOp("TaskUpdate", { status: "completed" })).toBeNull(); // 无 id 无从落账
  });

  // 回归：真实 harness 的 TaskUpdate 入参是 snake_case task_id——曾按 camelCase 假设
  // 实现＋写测试，update 全被丢弃，TUI 的 plan 永远停在 pending（"做完了但 todo 不动"）
  test("TaskUpdate with snake_case task_id (real harness shape) settles the status", () => {
    expect(taskToolOp("TaskUpdate", { task_id: "1", status: "completed" })).toEqual({
      op: "update",
      taskId: "1",
      status: "completed",
    });

    const { events, feed } = claudeHarness();
    feed(toolUse("tu1", "TaskCreate", { subject: "确认演示范围" }));
    feed(toolResult("tu1", "Task #1 created successfully: 确认演示范围"));
    feed(toolUse("tu2", "TaskUpdate", { task_id: "1", status: "completed" }));
    feed(toolResult("tu2", "Updated task #1 status"));
    const plans = events.filter((e) => e.kind === "plan_update");
    expect((plans.at(-1)!.payload as { entries: unknown[] }).entries).toEqual([
      { content: "确认演示范围", priority: "medium", status: "completed" },
    ]);
  });
});

describe("background task / subagent lifecycle", () => {
  test("Claude SDK task edges upsert one first-class task", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Inspect the adapter",
      subagent_type: "Explore",
    });
    feed({
      type: "system",
      subtype: "task_progress",
      task_id: "task-1",
      description: "Inspect the adapter",
      summary: "Found the mapping",
      last_tool_name: "Read",
      usage: { total_tokens: 12, tool_uses: 2, duration_ms: 30 },
    });
    feed({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
      summary: "Done",
      output_file: "/tmp/task-1",
    });

    expect(events.map((event) => event.kind)).toEqual([
      "task_update",
      "task_update",
      "task_update",
    ]);
    expect(events.at(-1)).toMatchObject({
      payload: { taskId: "task-1", status: "completed", summary: "Done" },
    });
  });

  test("Codex collabAgentToolCall maps to the same task_update contract", () => {
    const { events, notify } = codexHarness();
    notify("item/started", {
      threadId: "th1",
      item: {
        id: "agent-1",
        type: "collabAgentToolCall",
        prompt: "Review this patch",
        agentType: "reviewer",
      },
    });
    notify("item/completed", {
      threadId: "th1",
      item: {
        id: "agent-1",
        type: "collabAgentToolCall",
        status: "completed",
        result: "Looks good",
      },
    });
    expect(events.map((event) => event.kind)).toEqual(["task_update", "task_update"]);
    expect(events.at(-1)).toMatchObject({
      payload: { taskId: "agent-1", status: "completed", summary: "Looks good" },
    });
  });
});

describe("native provider observability", () => {
  test("Codex traces every native notification before mapping", () => {
    const native: unknown[] = [];
    const adapter = new CodexAdapter({
      openInteraction,
      nativeEvent: (event) => native.push(event),
    });
    const rt = { threadId: "th1", activeTurn: { turnId: "t1", finalized: false } };
    (
      adapter as unknown as {
        handleNotification: (runtime: unknown, method: string, params: unknown) => void;
      }
    ).handleNotification(rt, "future/event", { threadId: "th1", value: 1 });
    expect(native).toEqual([
      {
        direction: "in",
        name: "future/event",
        payload: { threadId: "th1", value: 1 },
      },
    ]);
  });

  test("Claude reports an unknown SDK message once instead of silently dropping it", () => {
    const diagnostics: LogEntry[] = [];
    const adapter = new ClaudeAdapter({
      openInteraction,
      log: (entry) => diagnostics.push(entry),
    });
    const rt = {
      cwd: "/tmp",
      suppressedToolIds: new Set(),
      capturedProposedPlanKeys: new Set(),
      tasks: new Map(),
      pendingTaskOps: new Map(),
    };
    const turn = { turnId: "t1", finalized: false, cancelRequested: false };
    const handle = (
      adapter as unknown as {
        handleMessage: (
          runtime: unknown,
          emit: (event: AnyEventDraft) => void,
          message: unknown,
          active: unknown,
        ) => void;
      }
    ).handleMessage.bind(adapter);
    handle(rt, () => {}, { type: "future_message" }, turn);
    handle(rt, () => {}, { type: "future_message" }, turn);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("future_message");
  });
});

describe("claude: edit tools → diff content", () => {
  test("Skill title includes the launched skill name", () => {
    expect(claudeToolTitle("Skill", { skill: "devloop:gcampr" })).toBe("Skill: devloop:gcampr");
  });

  test("Edit carries intent-only modify diff (real patch arrives via tool_use_result)", () => {
    const diff = claudeToolDiff("Edit", { file_path: "/a/b.ts", old_string: "old", new_string: "new" });
    expect(diff).toEqual({
      type: "diff",
      changes: [{ operation: "modify", path: "/a/b.ts" }],
    });
  });

  test("Write is add; Bash has no diff", () => {
    expect(claudeToolDiff("Write", { file_path: "/a/new.ts", content: "x" })?.changes[0]!.operation).toBe("add");
    expect(claudeToolDiff("Bash", { command: "ls" })).toBeNull();
  });

  test("claudeResultDiff synthesizes a unified patch from structuredPatch", () => {
    const diff = claudeResultDiff({
      filePath: "/a/b.ts",
      oldString: "old",
      newString: "new",
      originalFile: "const x = 1;\nold\n",
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const x = 1;", "-old", "+new"] },
      ],
      userModified: false,
    });
    expect(diff).toEqual({
      type: "diff",
      changes: [{ operation: "modify", path: "/a/b.ts" }],
      patch: "--- /a/b.ts\n+++ /a/b.ts\n@@ -1,2 +1,2 @@\n const x = 1;\n-old\n+new",
    });
  });

  test("claudeResultDiff maps Write create to add with /dev/null header", () => {
    const diff = claudeResultDiff({
      type: "create",
      filePath: "/a/new.ts",
      content: "x\ny",
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] }],
    });
    expect(diff?.changes).toEqual([{ operation: "add", path: "/a/new.ts" }]);
    expect(diff?.patch).toBe("--- /dev/null\n+++ /a/new.ts\n@@ -0,0 +1,2 @@\n+x\n+y");
  });

  test("claudeResultDiff rejects unknown shapes instead of guessing", () => {
    expect(claudeResultDiff(undefined)).toBeNull();
    expect(claudeResultDiff("The file has been updated")).toBeNull();
    expect(claudeResultDiff({ filePath: "/a.ts", structuredPatch: [] })).toBeNull();
    // hunk 字段不合形状（私有格式漂移）→ 整体降级，不产出半合法 patch
    expect(claudeResultDiff({ filePath: "/a.ts", structuredPatch: [{ oldStart: "1", lines: ["+x"] }] })).toBeNull();
  });

  test("tool_use emits tool_call_update with diff block", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/a.ts", old_string: "1", new_string: "2" } }],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    expect(tc).toBeDefined();
    const content = (tc!.payload as { content: Array<{ type: string }> }).content;
    expect(content[0]!.type).toBe("diff");
  });

  test("tool_result appends displayable output without replacing existing content", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "command output\n" }] },
    });
    const chunk = events.find((e) => e.kind === "tool_call_content_chunk");
    expect(chunk?.payload).toEqual({
      toolCallId: "tu2",
      content: { type: "text", text: "command output\n" },
    });
  });

  test("edit tool_use_result backfills the real patch and suppresses duplicate text output", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu3", content: "The file /a.ts has been updated.\n" }] },
      tool_use_result: {
        filePath: "/a.ts",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    expect(tc?.payload).toMatchObject({
      toolCallId: "tu3",
      status: "completed",
      content: [
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/a.ts" }],
          patch: "--- /a.ts\n+++ /a.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
        },
      ],
    });
    // diff 即输出：编辑结果的说明文本与 patch 重复，不再追加文本块
    expect(events.find((e) => e.kind === "tool_call_content_chunk")).toBeUndefined();
  });
});

describe("structured questions", () => {
  test("Claude AskUserQuestion maps internal ids back to the full question-text wire keys", async () => {
    const events: AnyEventDraft[] = [];
    const interactions: InteractionDraft[] = [];
    const adapter = new ClaudeAdapter({
      openInteraction: async (interaction) => {
        interactions.push(interaction);
        return interaction.kind === "question"
          ? {
              kind: "question",
              outcome: "answered",
              answers: {
                [interaction.questions[0]!.questionId]: ["Careful"],
                [interaction.questions[1]!.questionId]: ["Unit", "Integration"],
              },
            }
          : { kind: "permission", outcome: "selected", optionId: "deny" };
      },
    });
    const result = await (
      adapter as unknown as {
        handleCanUseTool: (
          runtime: { capturedProposedPlanKeys: Set<string> },
          emit: (event: AnyEventDraft) => void,
          turnId: () => string,
          name: string,
          input: Record<string, unknown>,
          meta: Record<string, unknown>,
        ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
      }
    ).handleCanUseTool(
      { capturedProposedPlanKeys: new Set() },
      (event) => events.push(event),
      () => "t1",
      "AskUserQuestion",
      {
        questions: [
          {
            header: "Approach",
            question: "How should we proceed?",
            multiSelect: false,
            options: [{ label: "Careful", description: "Verify first" }],
          },
          {
            header: "Tests",
            question: "Which tests should run?",
            multiSelect: true,
            options: [
              { label: "Unit", description: "Fast checks" },
              { label: "Integration", description: "Cross-module checks" },
            ],
          },
        ],
      },
      { toolUseID: "tu-question" },
    );

    expect(events).toEqual([]);
    expect(interactions[0]).toMatchObject({
      kind: "question",
      toolCallId: "tu-question",
      questions: [
        {
          questionId: "q0",
          choices: [{ value: "Careful", label: "Careful" }],
        },
        {
          questionId: "q1",
          choices: [
            { value: "Unit", label: "Unit" },
            { value: "Integration", label: "Integration" },
          ],
        },
      ],
    });
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            header: "Approach",
            question: "How should we proceed?",
            multiSelect: false,
            options: [{ label: "Careful", description: "Verify first" }],
          },
          {
            header: "Tests",
            question: "Which tests should run?",
            multiSelect: true,
            options: [
              { label: "Unit", description: "Fast checks" },
              { label: "Integration", description: "Cross-module checks" },
            ],
          },
        ],
        answers: {
          "How should we proceed?": "Careful",
          "Which tests should run?": "Unit, Integration",
        },
      },
    });
  });

  test("Codex requestUserInput returns the app-server answer envelope", async () => {
    const events: AnyEventDraft[] = [];
    const interactions: InteractionDraft[] = [];
    const adapter = new CodexAdapter({
      openInteraction: async (interaction) => {
        interactions.push(interaction);
        return interaction.kind === "question"
          ? { kind: "question", outcome: "answered", answers: { approach: ["Fast", "Safe"] } }
          : { kind: "permission", outcome: "selected", optionId: "deny" };
      },
    });
    const result = await (
      adapter as unknown as {
        handleServerRequest: (runtime: unknown, method: string, params: unknown) => Promise<unknown>;
      }
    ).handleServerRequest(
      { threadId: "th1", sink: (event: AnyEventDraft) => events.push(event) },
      "item/tool/requestUserInput",
      {
        itemId: "item1",
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "Choose approaches",
            isOther: true,
            options: [{ label: "Fast", description: "Move quickly" }],
          },
        ],
      },
    );

    expect(events).toEqual([]);
    expect(interactions[0]).toMatchObject({
      kind: "question",
      questions: [{
        questionId: "approach",
        choices: [{ value: "Fast", label: "Fast" }],
      }],
    });
    expect(result).toEqual({ answers: { approach: { answers: ["Fast", "Safe"] } } });
  });
});

describe("codex: tool output mapping", () => {
  test("fileChange item maps object kinds and builds renderable unified patches", () => {
    const { events, notify } = codexHarness();
    notify("item/completed", {
      threadId: "th1",
      turnId: "ct1",
      item: {
        type: "fileChange",
        id: "fc1",
        status: "completed",
        changes: [
          { path: "/x.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" },
          { path: "/y.ts", kind: { type: "add" }, diff: "new file" },
          { path: "/z.ts", kind: { type: "delete" }, diff: "old file" },
        ],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    const content = (tc!.payload as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((block) => block.changes)).toEqual([
      [{ operation: "modify", path: "/x.ts" }],
      [{ operation: "add", path: "/y.ts" }],
      [{ operation: "delete", path: "/z.ts" }],
    ]);
    expect(content.map((block) => block.patch)).toEqual([
      "--- /x.ts\n+++ /x.ts\n@@ -1 +1 @@\n-old\n+new",
      "--- /dev/null\n+++ /y.ts\n@@ -0,0 +1,1 @@\n+new file",
      "--- /z.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old file",
    ]);
  });

  test("commandExecution outputDelta streams as tool_call_content_chunk", () => {
    const { events, notify } = codexHarness();
    notify("item/commandExecution/outputDelta", { threadId: "th1", turnId: "ct1", itemId: "cmd1", delta: "line1\n" });
    const chunk = events.find((e) => e.kind === "tool_call_content_chunk");
    expect(chunk).toBeDefined();
    expect((chunk!.payload as { toolCallId: string }).toolCallId).toBe("cmd1");
    expect((chunk!.payload as { content: { text: string } }).content.text).toBe("line1\n");
  });

  test("commandExecution completed backfills the full aggregated output", () => {
    const { events, notify } = codexHarness();
    notify("item/completed", {
      threadId: "th1",
      turnId: "ct1",
      item: {
        type: "commandExecution",
        id: "cmd1",
        status: "completed",
        command: "printf hello",
        aggregatedOutput: "hello\n",
      },
    });
    const update = events.find((e) => e.kind === "tool_call_update");
    expect((update!.payload as { content: Array<{ type: string; text: string }> }).content).toEqual([
      { type: "text", text: "hello\n" },
    ]);
  });
});

describe("codex: reasoning summary parts", () => {
  test("keeps each summary part as an independent thought message", () => {
    const { events, notify } = codexHarness();
    notify("item/reasoning/summaryTextDelta", {
      threadId: "th1",
      itemId: "rs1",
      summaryIndex: 0,
      delta: "**Inspecting files**\n\n<!-- -->",
    });
    notify("item/reasoning/summaryTextDelta", {
      threadId: "th1",
      itemId: "rs1",
      summaryIndex: 1,
      delta: "**Planning changes**\n\n<!-- -->",
    });
    notify("item/completed", {
      threadId: "th1",
      item: {
        type: "reasoning",
        id: "rs1",
        summary: ["**Inspecting files**\n\n<!-- -->", "**Planning changes**\n\n<!-- -->"],
      },
    });

    expect(
      events
        .filter((event) => event.kind === "agent_thought" || event.kind === "agent_thought_chunk")
        .map((event) => ({ kind: event.kind, messageId: (event.payload as { messageId: string }).messageId })),
    ).toEqual([
      { kind: "agent_thought_chunk", messageId: "rs1:summary:0" },
      { kind: "agent_thought_chunk", messageId: "rs1:summary:1" },
      { kind: "agent_thought", messageId: "rs1:summary:0" },
      { kind: "agent_thought", messageId: "rs1:summary:1" },
    ]);
  });
});

describe("claude: approval options", () => {
  test("without SDK suggestions there is no always option (baton 不自造授权规则)", () => {
    const options = claudeApprovalOptions(false);
    expect(options.map((o) => [o.polarity, o.lifetime])).toEqual([
      ["allow", "once"],
      ["reject", "once"],
    ]);
  });

  test("with suggestions a persistent allow appears between allow and deny", () => {
    const options = claudeApprovalOptions(true);
    expect(options.map((o) => [o.polarity, o.lifetime])).toEqual([
      ["allow", "once"],
      ["allow", "persistent"],
      ["reject", "once"],
    ]);
    expect(new Set(options.map((o) => o.optionId)).size).toBe(options.length);
  });
});

describe("run status: context compaction → _baton_run_status", () => {
  test("codex contextCompaction item maps to phase set/clear, no tool card", () => {
    const { events, notify } = codexHarness();
    notify("item/started", { threadId: "th1", turnId: "ct1", item: { type: "contextCompaction", id: "cc1" } });
    notify("item/completed", { threadId: "th1", turnId: "ct1", item: { type: "contextCompaction", id: "cc1" } });
    const statuses = events.filter((e) => e.kind === "_baton_run_status");
    expect(statuses.map((e) => e.payload)).toEqual([
      { phase: "compacting", title: "Compacting context…" },
      { phase: null },
    ]);
    expect(events.filter((e) => e.kind === "tool_call_update")).toHaveLength(0);
  });

  test("claude system/status maps compacting and clears on null", () => {
    const { events, feed } = claudeHarness();
    feed({ type: "system", subtype: "status", status: "compacting" });
    feed({ type: "system", subtype: "status", status: null });
    const statuses = events.filter((e) => e.kind === "_baton_run_status");
    expect(statuses.map((e) => e.payload)).toEqual([
      { phase: "compacting", title: "Compacting context…" },
      { phase: null },
    ]);
  });

  test("claude 'requesting' status degrades to no-phase (thinking fallback)", () => {
    const { events, feed } = claudeHarness();
    feed({ type: "system", subtype: "status", status: "requesting" });
    const statuses = events.filter((e) => e.kind === "_baton_run_status");
    expect(statuses.map((e) => e.payload)).toEqual([{ phase: null }]);
  });
});

describe("context usage → context_usage_update", () => {
  test("codex maps the latest turn usage and model context window as a snapshot", () => {
    const { events, notify } = codexHarness();
    notify("thread/tokenUsage/updated", {
      threadId: "th1",
      turnId: "ct1",
      tokenUsage: {
        total: { inputTokens: 20_000, cachedInputTokens: 10_000, outputTokens: 2_000 },
        last: { totalTokens: 12_500 },
        modelContextWindow: 200_000,
      },
    });
    expect(events.find((event) => event.kind === "context_usage_update")?.payload).toEqual({
      model: "default",
      contextUsed: 12_500,
      contextSize: 200_000,
    });
  });

  test("claude maps the primary model usage and context window as a snapshot", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "result",
      subtype: "success",
      usage: {},
      modelUsage: {
        "claude-sonnet": {
          inputTokens: 2_000,
          outputTokens: 100,
          cacheReadInputTokens: 8_000,
          cacheCreationInputTokens: 500,
          webSearchRequests: 0,
          costUSD: 0.12,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
    });
    expect(events.find((event) => event.kind === "context_usage_update")?.payload).toEqual({
      model: "default",
      contextUsed: 10_500,
      contextSize: 200_000,
      cost: { amount: 0.12, currency: "USD" },
    });
  });

  test("claude prefers the latest message_start usage over cumulative modelUsage", () => {
    const { events, feed } = claudeHarness();
    // modelUsage 跨 turn 累计会虚高；message_start 的当次调用 usage 才是当前 context 占用。
    feed({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          model: "claude-sonnet-4",
          usage: { input_tokens: 1_000, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 0 },
        },
      },
    });
    feed({
      type: "result",
      subtype: "success",
      usage: {},
      modelUsage: {
        "claude-sonnet-4": {
          inputTokens: 60_000,
          outputTokens: 3_000,
          cacheReadInputTokens: 90_000,
          cacheCreationInputTokens: 10_000,
          webSearchRequests: 0,
          costUSD: 0.5,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
    });
    expect(events.find((event) => event.kind === "context_usage_update")?.payload).toEqual({
      model: "default",
      contextUsed: 5_000,
      contextSize: 200_000,
      cost: { amount: 0.5, currency: "USD" },
    });
  });
});

describe("claude: api_error_status result", () => {
  test("529 overload result surfaces a retryable error update instead of a silent end_turn", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "result",
      subtype: "success",
      api_error_status: 529,
      usage: {},
      modelUsage: {},
    });
    const error = events.find((event) => event.kind === "_baton_error_update");
    expect(error?.payload).toEqual({
      code: "api_error_529",
      message: "Claude API overloaded (529): retries exhausted, turn ended early",
      retryable: true,
      willRetry: false,
    });
    expect(events.find((event) => event.kind === "state_update")?.payload).toEqual({
      state: "idle",
      stopReason: "end_turn",
    });
  });

  test("result without api_error_status emits no error update", () => {
    const { events, feed } = claudeHarness();
    feed({ type: "result", subtype: "success", usage: {}, modelUsage: {} });
    expect(events.filter((event) => event.kind === "_baton_error_update")).toHaveLength(0);
  });
});
