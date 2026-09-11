import type { PromptBlock } from "../../event/index.ts";
import type { ApprovalRoute, ReconcileState } from "../adapter.ts";
import {
  sessionIdFromResumeState,
  type HarnessResumeState,
} from "../resume.ts";
import { CODEX_FAST_CONFIG } from "./runtime.ts";
import { STARTUP_REQUEST_TIMEOUT_MS } from "./process.ts";

function approvalRouteOf(reviewer: unknown): ApprovalRoute | null {
  if (reviewer === "user") return "user";
  if (reviewer === "auto_review" || reviewer === "guardian_subagent") return "delegated";
  return null;
}

/** 只翻译 thread/read 的 live status；未知状态保守返回 unknown。 */
export function mapThreadStatus(
  status: { type?: string; activeFlags?: string[] } | undefined,
): ReconcileState {
  switch (status?.type) {
    case "idle":
      return "idle";
    case "active":
      if (status.activeFlags?.includes("waitingOnApproval")) return "waiting_approval";
      if (status.activeFlags?.includes("waitingOnUserInput")) return "waiting_input";
      return "active";
    default:
      return "unknown";
  }
}

/**
 * 计入"turn 有产出"的事件 kind（空回合判定，见 CodexTurn.sawOutput）。
 * usage/state 等记账类事件不算产出；`_baton_run_status`（compaction 等运行阶段）算——
 * 纯 compaction turn 合法无消息产出，不应误报空回合。
 */
export const OUTPUT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call_update",
  "tool_call_content_chunk",
  "plan_update",
  "plan_remove",
  "_baton_run_status",
]);

export interface CodexThreadPeer {
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

export function threadIdFrom(response: unknown, method: string): string {
  const threadId = (response as { thread?: { id?: string } })?.thread?.id;
  if (!threadId) throw new Error(`codex ${method} returned no thread id`);
  return threadId;
}

export function missingThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread.*not found|no rollout found|session.*not found/i.test(message);
}

/** thread/start|resume 响应回吐的生效 reviewer（非可选字段）；缺失只降级为"不知道"。 */
export function routeFrom(response: unknown): ApprovalRoute | null {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  return approvalRouteOf(record.approvalsReviewer);
}

/** thread/start|resume 对 feature gate 与模型支持校验后的 service tier。 */
export function serviceTierFrom(response: unknown): string | null {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  return typeof record.serviceTier === "string" ? record.serviceTier : null;
}

/**
 * 恢复优先；原生 thread 已丢失时新建，BatonSession 会在宿主层补齐历史。
 *
 * `approvalsReviewer` 只在用户显式配置时下发；resume 时同样如此——codex 会把 reviewer
 * 随 thread 持久化，不传就沿用该 thread 原有的选择（thread_resume_preserves_persisted_
 * approvals_reviewer）。响应回吐的才是生效值：企业 requirements 可能把请求值打回。
 */
export async function openCodexThread(
  peer: CodexThreadPeer,
  opts: {
    cwd: string;
    resumeState?: HarnessResumeState;
    resumeSessionId?: string;
    approvalReviewer?: "user" | "auto_review";
  },
): Promise<{
  threadId: string;
  resumed: boolean;
  route: ApprovalRoute | null;
  serviceTier: string | null;
}> {
  const reviewer = opts.approvalReviewer ? { approvalsReviewer: opts.approvalReviewer } : {};
  // 只开启 Fast 的可选能力；是否付费走 Fast 仍由 serviceTier 明确切换。
  const config = { config: CODEX_FAST_CONFIG };
  const resumeSessionId = opts.resumeState
    ? sessionIdFromResumeState(opts.resumeState)
    : opts.resumeSessionId;
  if (resumeSessionId) {
    try {
      const response = await peer.request(
        "thread/resume",
        { threadId: resumeSessionId, ...reviewer, ...config },
        { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS },
      );
      return {
        threadId: threadIdFrom(response, "thread/resume"),
        resumed: true,
        route: routeFrom(response),
        serviceTier: serviceTierFrom(response),
      };
    } catch (error) {
      if (!missingThread(error)) throw error;
    }
  }

  const response = await peer.request(
    "thread/start",
    { cwd: opts.cwd, ...reviewer, ...config },
    { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS },
  );
  return {
    threadId: threadIdFrom(response, "thread/start"),
    resumed: false,
    route: routeFrom(response),
    serviceTier: serviceTierFrom(response),
  };
}

export type CodexPromptItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

/** Baton prompt blocks → app-server v2 UserInput. */
export function codexPromptInput(blocks: PromptBlock[]): CodexPromptItem[] {
  return blocks.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type !== "image") {
      throw new Error(`codex prompt block was not admitted: ${block.type}`);
    }
    if (block.path) return { type: "localImage", path: block.path };
    if (block.data) {
      return {
        type: "image",
        url: `data:${block.mimeType};base64,${block.data}`,
      };
    }
    throw new Error("codex image prompt block requires path or base64 data");
  });
}

