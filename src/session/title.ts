// Session 标题的 LLM 生成编排（fire-and-forget 旁路）：
// 每个主 Queue Turn 收口后由 controller 触发，从事件流取当前用户输入，
// 经 textgen 路由器跨 harness 降级生成标题。护栏：title 非空且不等于机械 preview
// 视为用户/adopted 命名，绝不覆盖（对齐 t3code canReplaceThreadTitle）。
// 任何失败都静默降级为 sessionPreview——标题是增强，不是主流程。

import { textOf } from "../event/index.ts";
import type { BatonConfig } from "../config/config.ts";
import { configuredHarnessTargets } from "../harness/registry.ts";
import type { HarnessTarget } from "../harness/target.ts";
import {
  buildSessionTitlePrompt,
  generateStructuredWithFallback,
  sanitizeSessionTitle,
  SESSION_TITLE_SCHEMA,
  type TextgenCandidate,
} from "../harness/textgen.ts";
import type { LogSink } from "../logging.ts";
import { sessionPreview, type SessionHandle } from "../store/store.ts";

/** 已配置 Target 的 textgen 降级链候选；controller 会把当前 Target 前置。 */
export function configuredTextgenTargets(config: BatonConfig): HarnessTarget[] {
  return configuredHarnessTargets(config);
}

/**
 * 取当前 Session 自己截至现在的非空用户输入。用全部输入是为了让“你好”之后才出现的
 * 真正主题能在后续 Turn 重试时被看到。fork 复制了源事件，必须越过分叉边界。
 */
function sessionUserText(session: SessionHandle): string | undefined {
  const forkBoundary = session.meta.forkedFrom?.throughSeq;
  const messages: string[] = [];
  for (const event of session.ledger.read()) {
    if (forkBoundary !== undefined && event.seq <= forkBoundary) continue;
    if (event.kind !== "user_message" || event.source.type === "plugin") {
      continue;
    }
    const payload = event.payload as { content?: Parameters<typeof textOf>[0] };
    const text = textOf(payload.content ?? []).trim();
    if (text) messages.push(text);
  }
  return messages.length > 0 ? messages.join("\n\n") : undefined;
}

/** 历史版本已经落盘的低信息 textgen 结果，允许后续 Turn 修正。 */
const RETRYABLE_GENERATED_TITLES = new Set(["开始新的协作会话"]);
const LOW_INFORMATION_USER_TEXT =
  /^(?:你好|您好|嗨|哈[啰喽罗]|在吗|好的?|收到|谢谢|hi|hello|hey|thanks|thank you)[\s!！,.，。?？~～]*$/iu;

/** 当前 title 是否允许被 LLM 标题替换：空，或仍等于机械 preview（即自动生成物）。 */
export function canReplaceSessionTitle(
  title: string | undefined,
  userText: string | undefined,
): boolean {
  const current = title?.trim();
  if (!current) return true;
  if (RETRYABLE_GENERATED_TITLES.has(current)) return true;
  const preview = userText ? sessionPreview(userText) : undefined;
  return preview !== undefined && current === preview;
}

export async function maybeGenerateSessionTitle(opts: {
  session: SessionHandle;
  candidates: readonly TextgenCandidate[];
  models?: Record<string, string>;
  log?: LogSink;
}): Promise<boolean> {
  const { session, log } = opts;
  const userText = sessionUserText(session);
  if (
    !userText ||
    LOW_INFORMATION_USER_TEXT.test(userText) ||
    !canReplaceSessionTitle(session.meta.title, userText)
  ) return false;

  const result = await generateStructuredWithFallback(
    opts.candidates,
    {
      prompt: buildSessionTitlePrompt(userText),
      jsonSchema: SESSION_TITLE_SCHEMA,
      cwd: session.meta.cwd,
    },
    { ...(opts.models ? { models: opts.models } : {}), ...(log ? { log } : {}) },
  );
  if (!result) return false;

  const raw = (result.value as { title?: unknown } | undefined)?.title;
  const title = sanitizeSessionTitle(raw);
  if (!title) return false;

  // 生成期间用户可能已手动命名——落盘前再查一次护栏，后写不赢用户。
  if (!canReplaceSessionTitle(session.meta.title, userText)) return false;
  session.updateMeta({ title });
  log?.({
    level: "info",
    source: "baton",
    component: "textgen",
    harness: result.harness,
    message: "session title generated",
    attributes: { title },
  });
  return true;
}
