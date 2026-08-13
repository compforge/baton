// Session 标题的 LLM 生成编排（fire-and-forget 旁路）：
// 首个主 Queue Turn 收口后由 controller 触发一次，从事件流取第一条用户输入，
// 经 textgen 路由器跨 harness 降级生成标题。护栏：title 非空且不等于机械 preview
// 视为用户/adopted 命名，绝不覆盖（对齐 t3code canReplaceThreadTitle）。
// 任何失败都静默降级为 sessionPreview——标题是增强，不是主流程。

import { textOf } from "../event/index.ts";
import { HARNESSES, resolveDefaultHarnessTarget } from "../harness/registry.ts";
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

/** bundled harness 的 textgen 降级链候选（session 标题用）；controller 会把当前 target 前置。 */
export function bundledTextgenTargets(): HarnessTarget[] {
  return HARNESSES.flatMap((harness) => {
    const target = resolveDefaultHarnessTarget(harness);
    return target ? [target] : [];
  });
}

/**
 * 取当前 Session 自己的第一条非空用户输入。fork 复制了源事件，必须越过分叉边界，
 * 否则会拿源问题与 fork 的机械标题比较，并把后者误判成用户命名。
 */
function firstUserText(session: SessionHandle): string | undefined {
  const forkBoundary = session.meta.forkedFrom?.throughSeq;
  for (const event of session.ledger.read()) {
    if (forkBoundary !== undefined && event.seq <= forkBoundary) continue;
    if (event.kind !== "user_message" || event.source.type === "plugin") {
      continue;
    }
    const payload = event.payload as { content?: Parameters<typeof textOf>[0] };
    const text = textOf(payload.content ?? []).trim();
    if (text) return text;
  }
  return undefined;
}

/** 当前 title 是否允许被 LLM 标题替换：空，或仍等于机械 preview（即自动生成物）。 */
export function canReplaceSessionTitle(
  title: string | undefined,
  userText: string | undefined,
): boolean {
  const current = title?.trim();
  if (!current) return true;
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
  const userText = firstUserText(session);
  if (!userText || !canReplaceSessionTitle(session.meta.title, userText)) return false;

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
