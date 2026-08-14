// textgen 的 core 侧（harness 无关）：候选 adapter 按优先级排序、失败静默降级到
// 下一家、全部失败返回 undefined——调用方（session 标题等旁路功能）因此永远有
// 机械兜底，textgen 失败不会变成用户可见错误。路由器只做 feature detection
// （isTextGeneratable），不出现 harness 分支；模型 ID 方言由各 adapter 自己收口。

import type { LogSink } from "../logging.ts";
import { isTextGeneratable, type HarnessAdapter, type TextgenRequest } from "./adapter.ts";

export interface TextgenCandidate {
  /** 仅用于日志与模型覆盖查找（canonical harness id）。 */
  harness: string;
  adapter: HarnessAdapter;
}

export interface TextgenResult {
  value: unknown;
  /** 实际产出结果的 harness（降级后与首选不同）。 */
  harness: string;
}

/**
 * 按候选顺序依次尝试声明了 textgen 的 adapter；任一失败（quota/auth/超时/输出非法）
 * 记 warn 后降级下一家，全部失败返回 undefined。`models` 按 harness id 覆盖模型。
 */
export async function generateStructuredWithFallback(
  candidates: readonly TextgenCandidate[],
  request: Omit<TextgenRequest, "model">,
  opts: { models?: Record<string, string>; log?: LogSink } = {},
): Promise<TextgenResult | undefined> {
  for (const candidate of candidates) {
    // 以声明为准（契约同其他 capability）：未声明 textgen 的一律跳过；
    // isTextGeneratable 只是声明与实现一致性的兜底检查（契约测试钉住两边）。
    if (!candidate.adapter.capabilities.textgen || !isTextGeneratable(candidate.adapter)) continue;
    try {
      const value = await candidate.adapter.generateStructured({
        ...request,
        ...(opts.models?.[candidate.harness] ? { model: opts.models[candidate.harness] } : {}),
      });
      return { value, harness: candidate.harness };
    } catch (error) {
      opts.log?.({
        level: "warn",
        source: "baton",
        component: "textgen",
        harness: candidate.harness,
        message: "textgen candidate failed, falling back",
        attributes: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Session 标题生成
// ---------------------------------------------------------------------------

export const SESSION_TITLE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
};

const TITLE_INPUT_MAX_CHARS = 8_000;
export const SESSION_TITLE_MAX_CHARS = 50;

const GENERIC_SESSION_TITLES = new Set([
  "new chat",
  "new conversation",
  "new session",
  "start a new chat",
  "start a new conversation",
  "start a new session",
  "新会话",
  "新的会话",
  "开始新会话",
  "新对话",
  "新的对话",
  "开始新的对话",
  "开始新的协作会话",
]);

/**
 * 初始标题 prompt（编辑规则移植自 t3code TextGenerationPrompts，按 baton 语境调整）：
 * 目标是"几周后还能认出这个 session"，先归约 Subject/Outcome 再命名，丢弃过程性指令。
 */
export function buildSessionTitlePrompt(userText: string): string {
  const message =
    userText.length <= TITLE_INPUT_MAX_CHARS ? userText : `${userText.slice(0, TITLE_INPUT_MAX_CHARS)}…`;
  return `Generate a title that will help the user recognize this Baton session weeks later.
Return JSON with exactly one key: title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when linked or attached context reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Do not repeat the project or working directory name; it is already visible elsewhere in the UI.
- Avoid quotes, labels, filler, and trailing punctuation.
- Reply in the same language as the user's message.
- Ignore greetings and acknowledgements. If the messages do not yet reveal a durable subject or outcome, return an empty title so a later turn can retry.

User messages so far:
${message}`;
}

/**
 * 模型输出的防御性清洗（对齐 t3code sanitizeThreadTitle）：取首行、去引号、压缩空白、
 * 有界截断。空输出返回 undefined——调用方保留机械 preview，不写入垃圾标题。
 */
export function sanitizeSessionTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw
    .trim()
    .split(/\r?\n/g)[0]
    ?.trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return undefined;
  if (GENERIC_SESSION_TITLES.has(normalized.toLocaleLowerCase())) return undefined;
  const chars = [...normalized];
  return chars.length <= SESSION_TITLE_MAX_CHARS
    ? normalized
    : `${chars.slice(0, SESSION_TITLE_MAX_CHARS - 3).join("").trimEnd()}...`;
}
