// 把事件流 reduce 成会话状态：TUI 渲染的唯一来源，崩溃恢复 = 重放 session.jsonl。
// upsert 语义保证重放幂等。见 docs/workflow.md“Adapter 归一”。

import type {
  AnyEventEnvelope,
  ApprovalReviewUpdate,
  AvailableCommand,
  ContentBlock,
  ContextWindowUpdate,
  ContextUsageUpdate,
  ErrorUpdate,
  EventEnvelope,
  EventSource,
  HarnessInvocationCancelled,
  HarnessInvocationFailed,
  HarnessInvocationRecorded,
  HarnessTaskUpdate,
  MessageRole,
  Notice,
  PlanUpdate,
  PromptBlock,
  ProposedPlan,
  SessionConfigOption,
  SessionRunState,
  StopReason,
  SubmitDelivery,
  ToolCallStatus,
  TurnSummary,
  UsageUpdate,
} from "../event/index.ts";
import type {
  Interaction,
  InteractionResult,
} from "../interaction/types.ts";
import {
  normalizeHarnessInputStatus,
  type HarnessInputSource,
  type HarnessInputStatus,
} from "../harness/input.ts";

export interface MessageState {
  messageId: string;
  role: MessageRole;
  content: ContentBlock[];
  /** agent/thought chunk 仍在流式追加；完整 upsert 后转 completed。 */
  streamStatus?: "in_progress" | "completed";
  turnId?: string;
  /** 产生该消息的 harness（多 agent 同时间线时用于标注说话人） */
  harness?: string;
  /** 产生该消息的具体配置目标；状态归属与查询使用它，不用 Harness 类型代替。 */
  harnessTargetId?: string;
  laneId?: string;
  /** Who caused this message fact; message role remains a separate axis. */
  source?: EventSource;
  /** 仅 user 消息：effective delivery（steer = 中途注入当前 turn），缺省 = prompt */
  delivery?: SubmitDelivery;
  /** 仅 steer：pending 仍在 Harness 队列，applied 已进入模型上下文，failed 已确认未应用。 */
  deliveryState?: "pending" | "applied" | "failed";
}

export interface ToolCallState {
  toolCallId: string;
  /** 产生该工具活动的 harness；多 harness 时间线展示归属时使用。 */
  harness?: string;
  /** 产生该工具活动的具体配置目标。 */
  harnessTargetId?: string;
  laneId?: string;
  title?: string;
  kind?: string;
  status: ToolCallStatus;
  content: ContentBlock[];
  locations: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  turnId?: string;
}

export interface PlanState extends PlanUpdate {
  /** 产生该计划的 harness；pinned plan 只跟随当前输入目标。 */
  harness?: string;
  /** 产生该计划的具体配置目标。 */
  harnessTargetId?: string;
  laneId?: string;
}

export interface ProposedPlanState extends ProposedPlan {
  harness?: string;
  harnessTargetId?: string;
  laneId?: string;
  turnId?: string;
  implementationTurnId?: string;
  implementationStartedAt?: string;
}

export interface HarnessTaskState extends HarnessTaskUpdate {
  harness?: string;
  harnessTargetId?: string;
  laneId?: string;
  turnId?: string;
  /** First observed lifecycle edge; projection-only elapsed time survives replay. */
  startedAt?: number;
}

/**
 * HarnessTarget-scoped 会话状态的统一槽位，键 = 事件信封 `harnessTargetId`。
 * `harness` 只描述协议/Adapter 类型，不能作为状态实例的查询键：同一种 Harness
 * 可以有多个 Target。新增“每个 Target 各有一份”的状态时统一加在这里。
 */
export interface HarnessTargetState {
  /** 该 Target 使用的 Harness 协议类型；仅供展示和能力解释。 */
  harness?: string;
  /** 最近 context 占用快照（整体替换）。带 model 标签：切 model 后旧快照按标签判失效 */
  contextUsage?: ContextUsageUpdate;
  /** 最近一次严格配对的 model route context window 快照。 */
  contextWindow?: ContextWindowUpdate;
  /** 该 Target 最近一次 plan 的 id（plan 本体在 plans）。 */
  lastPlanId?: string;
  /** 该 Target 最近一次可用命令完整快照。 */
  availableCommands: AvailableCommand[];
  /** 该 Target 最近一次配置项完整快照。 */
  configOptions: SessionConfigOption[];
}

export type LaneTargetState = HarnessTargetState;

/** TUI 时间线条目：message / tool_call / plan / notice / error 按首次出现排序 */
export interface TimelineItem {
  type: "message" | "tool_call" | "plan" | "proposed_plan" | "task" | "notice" | "approval_review" | "error" | "harness_invocation";
  id: string;
}

export interface TurnSummaryState extends TurnSummary {
  harness?: string;
  harnessTargetId?: string;
  laneId?: string;
}

export interface HarnessInvocationState {
  invocationId: string;
  verb: HarnessInvocationRecorded["verb"];
  title: string;
  pluginInstanceId?: string;
  phase:
    | "queued"
    | "running"
    | "uncertain"
    | "completed"
    | "cancelled"
    | "failed";
  harnessTargetId?: string;
  requestedLaneId: string;
  newLane: boolean;
  laneId?: string;
  messageId?: string;
  turnId?: string;
  attemptId?: string;
  result?: TurnSummaryState;
  cancellation?: HarnessInvocationCancelled;
  failure?: HarnessInvocationFailed;
}

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  hasEstimated: boolean;
}

/** 一个仍在运行的 turn 的投影状态（running 开界、本 turn idle 收界） */
export interface ActiveTurnState {
  turnId: string;
  harness?: string;
  harnessTargetId?: string;
  laneId?: string;
  /** 本 turn 当前非 idle 态（running / requires_action）：保真透传，不折叠成 running */
  state: Exclude<SessionRunState, "idle">;
  startedAt?: number;
  /** per-turn 运行阶段（compacting…）：null phase 或本 turn idle 清除（阶段不跨 turn） */
  phase?: { phase: string; title?: string };
}

export interface InteractionState {
  interaction: Interaction;
  /** 请求交互的 Event 执行坐标；用于 per-turn requires_action 与 cancel-cascade 投影。 */
  turnId?: string;
  laneId?: string;
  /** 缺省即 pending；终结结果存在后不再要求用户动作。 */
  result?: InteractionResult;
}

export interface HarnessInputState {
  messageId: string;
  turnId: string;
  harnessTargetId: string;
  laneId: string;
  harness?: string;
  status: HarnessInputStatus;
  delivery: "prompt" | "steer";
  deliveryOutcome?: "applied" | "failed";
  blocks: PromptBlock[];
  source: HarnessInputSource;
  harnessInvocationId?: string;
}

export interface SessionState {
  /** 派生值：pending Interaction 或任一 turn requires_action ⇒ requires_action；activeTurns 空 ⇒ idle；否则 running。 */
  runState: SessionRunState;
  lastStopReason?: StopReason;
  /**
   * running 且尚未收到本 turn idle 的 turns。并发 Turn 各占一席，
   * 任何一个收口只清自己——busy/流式/运行行等呈现一律从这里聚合派生。
   */
  activeTurns: Map<string, ActiveTurnState>;
  /** per-turn 终态 stopReason：并发 turn 交错收口时按 turn 取值，不共享单槽 */
  stopReasons: Map<string, StopReason>;
  timeline: TimelineItem[];
  messages: Map<string, MessageState>;
  /**
   * 全部 HarnessInput 的投影（含终态）：Queue 区与 Transcript 的单源。
   * steer 投递结果在 deliveryOutcome，与调度 status 正交（回执可迟到于 Turn 收口）。
   */
  harnessInputs: Map<string, HarnessInputState>;
  toolCalls: Map<string, ToolCallState>;
  plans: Map<string, PlanState>;
  /** 已完成、尚未表示执行授权的计划提案；按 planId 首写即定。 */
  proposedPlans: Map<string, ProposedPlanState>;
  /** Harness 已启动的异步任务 / subagent，按 provider task id upsert。 */
  tasks: Map<string, HarnessTaskState>;
  /** Interaction 是统一持久对象；是否 pending 由 result 是否存在派生。 */
  interactions: Map<string, InteractionState>;
  /**
   * auto-review 回执，按回执自身的 `reviewId` 归档（见 docs/approval-lifecycle.md）。与 Interaction
   * 正交：这是“已被 reviewer 决策”的留痕，不是待决，不派生 requires_action。每条回执是
   * timeline 的一等公民（首见即入 timeline），无 target 也留痕、同一操作多次决策各自成条。
   */
  approvalReviews: Map<string, ApprovalReviewUpdate>;
  /** Compact cards for non-user Turn initiation; raw events remain available by Lane. */
  harnessInvocations: Map<string, HarnessInvocationState>;
  usage: UsageTotal;
  /** Target-scoped 状态统一入口；Harness 类型不是状态实例的查询键。 */
  perTarget: Map<string, HarnessTargetState>;
  /** Lane × Target 原生 binding 状态；同一 Lane 可以跨多个 Target 接力。 */
  perLaneTarget: Map<string, LaneTargetState>;
  /** 最近一次结构化错误；willRetry 时 runState 仍应为 running（由事件源保证） */
  lastError?: ErrorUpdate & { seq: number; laneId?: string };
  /**
   * 错误历史（append-only），同时进 timeline（id 为 `err_<seq>`）：
   * 启动失败、admission 错误、quota 耗尽等属于会话流的一部分，要按发生位置内联展示。
   */
  errors: Map<string, ErrorUpdate & { seq: number; laneId?: string }>;
  /**
   * 提示历史（append-only），同时进 timeline（id 为 `n_<seq>`）：打断标记、
   * harness warning 等属于会话流的一部分，要按发生位置内联展示。
   */
  notices: Array<Notice & { seq: number; laneId?: string }>;
  turnSummaries: TurnSummaryState[];
  lastSeq: number;
}

export function emptySessionState(): SessionState {
  return {
    runState: "idle",
    activeTurns: new Map(),
    stopReasons: new Map(),
    timeline: [],
    messages: new Map(),
    harnessInputs: new Map(),
    toolCalls: new Map(),
    plans: new Map(),
    proposedPlans: new Map(),
    tasks: new Map(),
    interactions: new Map(),
    approvalReviews: new Map(),
    harnessInvocations: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      hasEstimated: false,
    },
    perTarget: new Map(),
    perLaneTarget: new Map(),
    errors: new Map(),
    notices: [],
    turnSummaries: [],
    lastSeq: 0,
  };
}

function roleOfKind(kind: string): MessageRole {
  if (kind.startsWith("user_")) return "user";
  if (kind.startsWith("agent_thought")) return "thought";
  return "agent";
}

function getOrCreateMessage(
  state: SessionState,
  id: string,
  role: MessageRole,
  turnId?: string,
  harness?: string,
  harnessTargetId?: string,
  laneId?: string,
  source?: EventSource,
): MessageState {
  let msg = state.messages.get(id);
  if (!msg) {
    msg = {
      messageId: id,
      role,
      content: [],
      turnId,
      harness,
      harnessTargetId,
      laneId,
      ...(source === undefined ? {} : { source: { ...source } }),
    };
    state.messages.set(id, msg);
    state.timeline.push({ type: "message", id });
  } else {
    if (!msg.harness) msg.harness = harness;
    if (!msg.harnessTargetId) msg.harnessTargetId = harnessTargetId;
    if (!msg.laneId) msg.laneId = laneId;
    if (!msg.source && source) msg.source = { ...source };
  }
  return msg;
}

function getOrCreateToolCall(
  state: SessionState,
  id: string,
  turnId?: string,
  harness?: string,
  harnessTargetId?: string,
  laneId?: string,
): ToolCallState {
  let tc = state.toolCalls.get(id);
  if (!tc) {
    tc = {
      toolCallId: id,
      harness,
      harnessTargetId,
      laneId,
      status: "pending",
      content: [],
      locations: [],
      turnId,
    };
    state.toolCalls.set(id, tc);
    state.timeline.push({ type: "tool_call", id });
  } else if (!tc.harness) {
    tc.harness = harness;
  }
  if (!tc.harnessTargetId) tc.harnessTargetId = harnessTargetId;
  if (!tc.laneId) tc.laneId = laneId;
  return tc;
}

function applyMessageUpsert(
  state: SessionState,
  ev: EventEnvelope<"user_message" | "agent_message" | "agent_thought">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const msg = getOrCreateMessage(
    state,
    p.messageId,
    role,
    ev.turnId,
    ev.harness,
    eventTargetId(ev),
    ev.laneId,
    ev.source,
  );
  // 三态：省略=不变；null/[]=清空；数组=整体替换
  if (p.content !== undefined) {
    msg.content = p.content === null ? [] : [...p.content];
  }
  // EventEnvelope<union> 不随 kind 自动收窄（非判别联合入参），手动断言 user_message
  if (ev.kind === "user_message") {
    const userMessage = (ev as EventEnvelope<"user_message">).payload;
    const delivery = userMessage.delivery;
    if (delivery !== undefined) msg.delivery = delivery;
    if (userMessage.deliveryState !== undefined) {
      msg.deliveryState = userMessage.deliveryState;
      // 老 ledger 兼容桥:steer 投递进度曾寄生在消息补丁上,还原时同步到 Input 投影。
      const input = state.harnessInputs.get(msg.messageId);
      if (input) {
        if (userMessage.deliveryState === "applied") input.deliveryOutcome = "applied";
        if (userMessage.deliveryState === "failed") {
          input.deliveryOutcome = "failed";
          input.status = "failed";
        }
      }
    }
    if (delivery === "follow_up") {
      // Esc may reclaim an unapplied native steer without changing messageId.
      // Its eventual prompt belongs to the new Turn and should appear after the
      // interrupted Turn, not at the hidden pending steer's original position.
      msg.turnId = ev.turnId;
      msg.harness = ev.harness;
      msg.harnessTargetId = eventTargetId(ev);
      msg.laneId = ev.laneId;
      const timelineIndex = state.timeline.findIndex(
        (item) => item.type === "message" && item.id === msg.messageId,
      );
      if (timelineIndex >= 0) {
        const [item] = state.timeline.splice(timelineIndex, 1);
        if (item) state.timeline.push(item);
      }
    }
  }
  if (role !== "user") msg.streamStatus = "completed";
}

function applyMessageChunk(
  state: SessionState,
  ev: EventEnvelope<"user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const msg = getOrCreateMessage(
    state,
    p.messageId,
    role,
    ev.turnId,
    ev.harness,
    eventTargetId(ev),
    ev.laneId,
    ev.source,
  );
  msg.content.push(p.content);
  if (role !== "user") msg.streamStatus = "in_progress";
}

function applyHarnessInputUpdate(
  state: SessionState,
  ev: EventEnvelope<"harness_input.updated">,
): void {
  const p = ev.payload;
  const status = normalizeHarnessInputStatus(p.status);
  const existing = state.harnessInputs.get(p.messageId);
  if (existing) {
    existing.status = status;
    existing.turnId = p.turnId;
    existing.delivery = p.delivery;
    if (p.blocks.length > 0) existing.blocks = [...p.blocks];
    return;
  }
  state.harnessInputs.set(p.messageId, {
    messageId: p.messageId,
    turnId: p.turnId,
    harnessTargetId: p.harnessTargetId,
    laneId: p.laneId,
    ...(ev.harness === undefined ? {} : { harness: ev.harness }),
    status,
    delivery: p.delivery,
    blocks: [...p.blocks],
    source: p.source,
    ...(p.harnessInvocationId === undefined
      ? {}
      : { harnessInvocationId: p.harnessInvocationId }),
  });
}

function applyInputDeliveryUpdate(
  state: SessionState,
  ev: EventEnvelope<"input_delivery_update">,
): void {
  const input = state.harnessInputs.get(ev.payload.messageId);
  // 迟到 applied(turn 已收口)是合法事实，只补 outcome 不回迁 status。
  if (input) {
    input.deliveryOutcome = ev.payload.state;
    if (ev.payload.state === "failed") input.status = "failed";
    return;
  }
  // 指向无 input 记录的老消息（老 ledger 没有 harness_input.updated）：镜像到
  // legacy deliveryState，消费侧的回落路径才能看到回执。
  const message = state.messages.get(ev.payload.messageId);
  if (message) message.deliveryState = ev.payload.state;
}

function applyToolCallUpdate(state: SessionState, ev: EventEnvelope<"tool_call_update">): void {
  const p = ev.payload;
  const tc = getOrCreateToolCall(
    state,
    p.toolCallId,
    ev.turnId,
    ev.harness,
    eventTargetId(ev),
    ev.laneId,
  );
  if (p.title !== undefined) tc.title = p.title === null ? undefined : p.title;
  if (p.kind !== undefined) tc.kind = p.kind === null ? undefined : p.kind;
  if (p.status !== undefined && p.status !== null) tc.status = p.status;
  if (p.content !== undefined) tc.content = p.content === null ? [] : [...p.content];
  if (p.locations !== undefined) tc.locations = p.locations === null ? [] : [...p.locations];
  if (p.rawInput !== undefined) tc.rawInput = p.rawInput;
  if (p.rawOutput !== undefined) tc.rawOutput = p.rawOutput;
}

/** 该 turn 是否还有未决 Interaction——per-turn requires_action 的派生依据。 */
function hasPendingBlocking(state: SessionState, turnId: string): boolean {
  for (const interaction of state.interactions.values()) {
    if (interaction.turnId === turnId && !interaction.result) return true;
  }
  return false;
}

/**
 * 会话级 runState 派生（workflow：存在 pending Interaction 时
 * projection 必须产出 requires_action）。requires_action 比 running 优先上浮——它意味着
 * "没有用户动作会话无法完整推进"；未归属 turn 的 setup Interaction 也不能漏。
 */
function deriveRunState(state: SessionState): SessionRunState {
  if ([...state.interactions.values()].some((interaction) => !interaction.result)) return "requires_action";
  if (state.activeTurns.size === 0) return "idle";
  return [...state.activeTurns.values()].some((turn) => turn.state === "requires_action")
    ? "requires_action"
    : "running";
}

function removePlan(state: SessionState, planId: string): void {
  state.plans.delete(planId);
  for (let index = state.timeline.length - 1; index >= 0; index--) {
    const entry = state.timeline[index];
    if (entry?.type === "plan" && entry.id === planId) state.timeline.splice(index, 1);
  }
  for (const scope of [...state.perTarget.values(), ...state.perLaneTarget.values()]) {
    if (scope.lastPlanId === planId) scope.lastPlanId = undefined;
  }
}

export function applyEvent(state: SessionState, ev: AnyEventEnvelope): SessionState {
  state.lastSeq = ev.seq;
  switch (ev.kind) {
    case "state_update": {
      const p = ev.payload;
      if (p.stopReason !== undefined) {
        state.lastStopReason = p.stopReason;
        if (ev.turnId) state.stopReasons.set(ev.turnId, p.stopReason);
      }
      if (p.state === "idle") {
        if (ev.turnId) {
          // 只收本 turn 的口：并发 Turn 互不误清
          state.activeTurns.delete(ev.turnId);
        } else {
          // 向后兼容：旧 jsonl / 旧版 crash recovery 的无 turnId idle 是全局收口语义
          state.activeTurns.clear();
        }
      } else if (ev.turnId) {
        // 非 idle 态（running / requires_action）：turn 在场。startedAt
        // 以首个 running 为准，重复 running（reconnect 重放）不重置起点；
        // state 保真透传（requires_action ↔ running 可来回迁移），但 pending blocking
        // request 在场时钉在 requires_action——重放的 running 不得掩盖未决审批卡片。
        const existing = state.activeTurns.get(ev.turnId);
        if (!existing) {
          // 新 turn 首见即作废旧 plan 的 pin：未完成条目永存是常态（任务中断/未逐条
          // TaskUpdate），不清会让上一段工作的 plan 在每个后续 turn 里借尸还魂；
          // 本 turn 若真的更新 plan，plan_update 会重新 pin。
          for (const scope of executionScopes(state, ev)) scope.lastPlanId = undefined;
        }
        state.activeTurns.set(ev.turnId, {
          turnId: ev.turnId,
          harness: ev.harness ?? existing?.harness,
          harnessTargetId: eventTargetId(ev) ?? existing?.harnessTargetId,
          laneId: ev.laneId ?? existing?.laneId,
          state: hasPendingBlocking(state, ev.turnId) ? "requires_action" : p.state,
          startedAt: existing?.startedAt ?? (ev.ts ? Date.parse(ev.ts) || undefined : undefined),
          phase: existing?.phase,
        });
      }
      break;
    }
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      applyMessageUpsert(state, ev, roleOfKind(ev.kind));
      if (ev.kind === "user_message") {
        const request = [...state.harnessInvocations.values()].find(
          (candidate) => candidate.messageId === ev.payload.messageId,
        );
        if (request) request.phase = "running";
      }
      break;
    }
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      applyMessageChunk(state, ev, roleOfKind(ev.kind));
      break;
    case "tool_call_update":
      applyToolCallUpdate(state, ev);
      break;
    case "harness_input.updated":
      applyHarnessInputUpdate(state, ev);
      break;
    case "input_delivery_update":
      applyInputDeliveryUpdate(state, ev);
      break;
    case "tool_call_content_chunk": {
      const p = ev.payload;
      const tc = getOrCreateToolCall(
        state,
        p.toolCallId,
        ev.turnId,
        ev.harness,
        eventTargetId(ev),
        ev.laneId,
      );
      tc.content.push(p.content);
      break;
    }
    case "plan_update": {
      const p = ev.payload;
      if (!state.plans.has(p.planId)) state.timeline.push({ type: "plan", id: p.planId });
      const existing = state.plans.get(p.planId);
      const harness = ev.harness ?? existing?.harness;
      state.plans.set(p.planId, {
        planId: p.planId,
        entries: [...p.entries],
        harness,
        harnessTargetId: eventTargetId(ev) ?? existing?.harnessTargetId,
        laneId: ev.laneId ?? existing?.laneId,
      });
      for (const scope of executionScopes(state, ev)) scope.lastPlanId = p.planId;
      break;
    }
    case "plan_remove":
      removePlan(state, ev.payload.planId);
      break;
    case "proposed_plan": {
      const p = ev.payload;
      // 提案是完成态产物，不做原地更新；重复事件不能改写用户已经看到的内容。
      if (state.proposedPlans.has(p.planId)) break;
      state.timeline.push({ type: "proposed_plan", id: p.planId });
      state.proposedPlans.set(p.planId, {
        ...p,
        harness: ev.harness,
        harnessTargetId: eventTargetId(ev),
        laneId: ev.laneId,
        turnId: ev.turnId,
      });
      break;
    }
    case "proposed_plan_implementation_started": {
      const proposal = state.proposedPlans.get(ev.payload.planId);
      if (!proposal || proposal.implementationTurnId) break;
      proposal.implementationTurnId = ev.payload.implementationTurnId;
      proposal.implementationStartedAt = ev.ts;
      break;
    }
    case "task_update": {
      const p = ev.payload;
      const existing = state.tasks.get(p.taskId);
      if (!existing && !p.skipTranscript) {
        state.timeline.push({ type: "task", id: p.taskId });
      }
      // optional 字段只做 defined patch；否则 live 对象里的 undefined 会抹掉旧值，
      // JSONL replay 时该字段又因 JSON.stringify 丢失，造成 live/resume 投影不一致。
      const next = { ...existing } as HarnessTaskState;
      for (const [key, value] of Object.entries(p)) {
        if (value !== undefined) {
          (next as unknown as Record<string, unknown>)[key] = value;
        }
      }
      if (!existing) {
        const startedAt = Date.parse(ev.ts);
        if (!Number.isNaN(startedAt)) next.startedAt = startedAt;
      }
      next.harness = ev.harness ?? existing?.harness;
      next.harnessTargetId = eventTargetId(ev) ?? existing?.harnessTargetId;
      next.laneId = ev.laneId ?? existing?.laneId;
      next.turnId = ev.turnId ?? existing?.turnId;
      state.tasks.set(p.taskId, next);
      break;
    }
    // Interaction requested/answered/cancelled 驱动 per-turn requires_action ↔ running：不变量收在 reducer，
    // 不要求 adapter 自觉配对 state_update（事件流是唯一真相源；见 docs/kernel.md）。
    // 原生 state_update(requires_action) 仍然有效——覆盖登录、设备确认等没有结构化
    // Interaction 的场景（workflow：反向不强制成立）。
    case "interaction.requested": {
      const interaction = ev.payload;
      const existing = state.interactions.get(interaction.interactionId);
      // lifecycle 事实只认第一次：重复 request 不能重写 requester/payload，更不能复活已终结对象。
      if (existing) break;
      state.interactions.set(interaction.interactionId, {
        interaction,
        turnId: ev.turnId,
        laneId: ev.laneId,
      });
      flagRequiresAction(state, ev.turnId);
      break;
    }
    case "interaction.answered": {
      const existing = state.interactions.get(ev.payload.interactionId);
      // terminal 只收一次；迟到/重复 answer 不得改写已经交付给 requester 的结果。
      if (!existing || existing.result) break;
      existing.result = ev.payload.answer;
      unflagRequiresAction(state, existing.turnId);
      break;
    }
    case "interaction.cancelled": {
      const existing = state.interactions.get(ev.payload.interactionId);
      if (!existing || existing.result) break;
      existing.result = {
        kind: "cancelled",
        reason: ev.payload.reason,
        ...(ev.payload.detail === undefined
          ? {}
          : { detail: ev.payload.detail }),
      };
      unflagRequiresAction(state, existing.turnId);
      break;
    }
    case "approval_review_update": {
      // 一等回执：按自己的 reviewId 归档、首见即进 timeline（无 target 也留痕、多次决策各自成条）。
      // 纯留痕，不参与 requires_action 派生。
      const p = ev.payload;
      if (!state.approvalReviews.has(p.reviewId)) {
        state.timeline.push({ type: "approval_review", id: p.reviewId });
      }
      state.approvalReviews.set(p.reviewId, p);
      break;
    }
    case "usage_update":
      accumulateUsage(state.usage, ev.payload);
      break;
    case "available_commands_update": {
      for (const scope of executionScopes(state, ev)) {
        scope.availableCommands = [...ev.payload.commands];
      }
      break;
    }
    case "config_option_update": {
      for (const scope of executionScopes(state, ev)) {
        scope.configOptions = [...ev.payload.options];
      }
      break;
    }
    case "context_usage_update": {
      // 旧 session replay：已落盘语义不可改变。新 Adapter 使用 context_window_update。
      for (const scope of executionScopes(state, ev)) {
        scope.contextUsage = { ...ev.payload };
      }
      break;
    }
    case "context_window_update": {
      for (const scope of executionScopes(state, ev)) {
        scope.contextWindow = { ...ev.payload };
      }
      break;
    }
    case "_baton_delivery_attempt_update": {
      const update = ev.payload;
      const request =
        update.phase === "prepared"
          ? [...state.harnessInvocations.values()].find(
              (candidate) => candidate.messageId === update.inputId,
            )
          : [...state.harnessInvocations.values()].find(
              (candidate) => candidate.attemptId === update.attemptId,
            );
      if (!request) break;
      request.attemptId = update.attemptId;
      if (update.phase === "uncertain") request.phase = "uncertain";
      else if (request.phase === "uncertain" && update.phase !== "finalized") {
        request.phase = "running";
      }
      break;
    }
    case "_baton_harness_invocation_recorded": {
      if (state.harnessInvocations.has(ev.payload.invocationId)) break;
      state.harnessInvocations.set(ev.payload.invocationId, {
        invocationId: ev.payload.invocationId,
        verb: ev.payload.verb,
        title: ev.payload.title,
        pluginInstanceId:
          ev.source.type === "plugin" ? ev.source.pluginInstanceId : undefined,
        phase: "queued",
        requestedLaneId: ev.payload.laneId,
        newLane: ev.payload.newLane,
        harnessTargetId: ev.payload.harnessTargetId,
      });
      state.timeline.push({
        type: "harness_invocation",
        id: ev.payload.invocationId,
      });
      break;
    }
    case "_baton_harness_invocation_scheduled": {
      const request = state.harnessInvocations.get(ev.payload.invocationId);
      if (!request) break;
      request.phase = "queued";
      request.harnessTargetId = ev.payload.harnessTargetId;
      request.laneId = ev.payload.laneId;
      request.messageId = ev.payload.messageId;
      request.turnId = ev.payload.turnId;
      break;
    }
    case "_baton_harness_invocation_cancelled": {
      const request = state.harnessInvocations.get(ev.payload.invocationId);
      if (
        request && request.phase !== "completed" && request.phase !== "failed"
      ) {
        request.phase = "cancelled";
        request.cancellation = { ...ev.payload };
      }
      break;
    }
    case "_baton_harness_invocation_failed": {
      const request = state.harnessInvocations.get(ev.payload.invocationId);
      if (
        request && request.phase !== "completed" && request.phase !== "cancelled"
      ) {
        request.phase = "failed";
        request.failure = { ...ev.payload };
      }
      break;
    }
    case "_baton_error_update": {
      const errorEntry = {
        ...ev.payload,
        seq: ev.seq,
        ...(ev.laneId ? { laneId: ev.laneId } : {}),
      };
      state.lastError = errorEntry;
      // 将错误加入 timeline 和 errors map
      const errorId = `err_${ev.seq}`;
      state.errors.set(errorId, errorEntry);
      state.timeline.push({ type: "error", id: errorId });
      break;
    }
    case "_baton_run_status": {
      const p = ev.payload;
      // per-turn 运行阶段；无 turnId 或未命中活跃 turn 时丢弃——phase 是短寿命
      // 短寿命装饰信息；turn 已收口后的迟到 phase 没有呈现意义。
      const turn = ev.turnId ? state.activeTurns.get(ev.turnId) : undefined;
      if (turn) turn.phase = p.phase === null ? undefined : { phase: p.phase, title: p.title };
      break;
    }
    case "_baton_notice":
      state.notices.push({
        ...ev.payload,
        seq: ev.seq,
        ...(ev.laneId ? { laneId: ev.laneId } : {}),
      });
      state.timeline.push({ type: "notice", id: `n_${ev.seq}` });
      break;
    case "_baton_turn_summary": {
      const summary: TurnSummaryState = {
        ...ev.payload,
        harness: ev.harness,
        harnessTargetId: ev.harnessTargetId,
        laneId: ev.laneId,
      };
      state.turnSummaries.push(summary);
      const request = [...state.harnessInvocations.values()].find(
        (candidate) => candidate.turnId === ev.payload.turnId,
      );
      if (
        request && request.phase !== "cancelled" && request.phase !== "failed"
      ) {
        request.phase = "completed";
        request.result = summary;
      }
      break;
    }
    default: {
      // 未知事件保留在 jsonl 里但不参与 reduce（forward-compat：不因未知 kind 崩溃）
      break;
    }
  }
  // 派生值统一在出口重算（纯函数、代价 O(activeTurns)）：单点维护不变量，
  // 不用每个 case 记得更新
  state.runState = deriveRunState(state);
  return state;
}

/** HarnessTarget 是唯一状态实例坐标；缺省即无 Target 归属，绝不从 Harness 类型反推。 */
function eventTargetId(ev: Pick<AnyEventEnvelope, "harnessTargetId">): string | undefined {
  return ev.harnessTargetId;
}

/** 取或建 Target 状态槽；所有 Target-scoped 快照只经过这一处归属。 */
function targetScoped(
  state: SessionState,
  ev: Pick<AnyEventEnvelope, "harnessTargetId" | "harness">,
): HarnessTargetState | undefined {
  const targetId = eventTargetId(ev);
  if (!targetId) return undefined;
  let scoped = state.perTarget.get(targetId);
  if (!scoped) {
    scoped = {
      harness: ev.harness,
      availableCommands: [],
      configOptions: [],
    };
    state.perTarget.set(targetId, scoped);
  } else if (!scoped.harness && ev.harness) {
    scoped.harness = ev.harness;
  }
  return scoped;
}

export function laneTargetStateKey(laneId: string, harnessTargetId: string): string {
  return `${laneId}\0${harnessTargetId}`;
}

function laneTargetScoped(
  state: SessionState,
  ev: Pick<AnyEventEnvelope, "harnessTargetId" | "laneId" | "harness">,
): LaneTargetState | undefined {
  const laneId = ev.laneId;
  const targetId = ev.harnessTargetId;
  if (!laneId || !targetId) return undefined;
  const key = laneTargetStateKey(laneId, targetId);
  let scoped = state.perLaneTarget.get(key);
  if (!scoped) {
    scoped = {
      harness: ev.harness,
      availableCommands: [],
      configOptions: [],
    };
    state.perLaneTarget.set(key, scoped);
  } else if (!scoped.harness && ev.harness) {
    scoped.harness = ev.harness;
  }
  return scoped;
}

function executionScopes(
  state: SessionState,
  ev: Pick<AnyEventEnvelope, "harnessTargetId" | "laneId" | "harness">,
): Array<HarnessTargetState | LaneTargetState> {
  return [targetScoped(state, ev), laneTargetScoped(state, ev)].filter(
    (scope): scope is HarnessTargetState | LaneTargetState => scope !== undefined,
  );
}

/** request 到场：所属 turn 派生为 requires_action（blocking request 挂起该 turn） */
function flagRequiresAction(state: SessionState, turnId: string | undefined): void {
  const turn = turnId ? state.activeTurns.get(turnId) : undefined;
  if (turn) turn.state = "requires_action";
}

/**
 * request 收口：仅当该 turn 已无其他 pending blocking request 时恢复 running——
 * 同 turn 并发多个审批时，应答一个不能提前撤掉 requires_action。
 */
function unflagRequiresAction(state: SessionState, turnId: string | undefined): void {
  const turn = turnId ? state.activeTurns.get(turnId) : undefined;
  if (turn && turn.state === "requires_action" && !hasPendingBlocking(state, turnId!)) {
    turn.state = "running";
  }
}

function accumulateUsage(total: UsageTotal, u: UsageUpdate): void {
  total.inputTokens += u.inputTokens ?? 0;
  total.outputTokens += u.outputTokens ?? 0;
  total.cacheReadTokens += u.cacheReadTokens ?? 0;
  total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  total.reasoningTokens += u.reasoningTokens ?? 0;
  if (u.isEstimated) total.hasEstimated = true;
}

export function reduceEvents(events: Iterable<AnyEventEnvelope>): SessionState {
  const state = emptySessionState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}

/**
 * 该 turn 是否仍在运行。消息级流式/思考态按所属 turn 判定，不看全局——
 * 并发 turn 下"别人 idle"不能把自己的流式状态打断。turnId 缺失（旧数据 /
 * 非 turn 事件）时回退"会话存在任一运行 turn"。
 */
export function isTurnRunning(state: SessionState, turnId: string | undefined): boolean {
  if (turnId === undefined) return state.activeTurns.size > 0;
  return state.activeTurns.has(turnId);
}
