// TextGeneratable 的 claude 实现（见 src/harness/adapter.ts）：一次性 SDK query，
// persistSession:false + 禁用工具/MCP/settings，结构化输出走 outputFormat json_schema。
// 与 probeClaudeTarget 同理——旁路工具调用必须对真实会话零副作用（不写 transcript、
// 不读项目 CLAUDE.md/hooks，避免用户项目配置污染一次工具性生成）。

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { TextgenRequest } from "../adapter.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
/** 标题这类小生成走便宜档；模型 ID 方言由本 adapter 收口，core 不传具体值。 */
const DEFAULT_TEXTGEN_MODEL = "haiku";

export interface ClaudeTextgenOptions {
  executablePath?: string;
  /** 测试注入点；生产始终使用 Agent SDK 的 query。 */
  queryFactory?: typeof query;
}

export async function generateClaudeStructured(
  request: TextgenRequest,
  options: ClaudeTextgenOptions = {},
): Promise<unknown> {
  const abortController = new AbortController();
  const queryHandle = (options.queryFactory ?? query)({
    prompt: request.prompt,
    options: {
      abortController,
      cwd: request.cwd,
      env: { ...(process.env as Record<string, string>) },
      allowedTools: [],
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      settingSources: [],
      systemPrompt: "You are a precise text generation utility. Follow the instructions exactly.",
      model: request.model ?? DEFAULT_TEXTGEN_MODEL,
      outputFormat: { type: "json_schema", schema: request.jsonSchema },
      ...(options.executablePath
        ? { pathToClaudeCodeExecutable: options.executablePath }
        : {}),
    },
  });

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`claude textgen timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([collectStructuredOutput(queryHandle), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    queryHandle.close();
  }
}

async function collectStructuredOutput(queryHandle: ReturnType<typeof query>): Promise<unknown> {
  for await (const message of queryHandle) {
    if (message.type !== "result") continue;
    if (message.subtype === "success") {
      if (message.structured_output === undefined) {
        const terminalReason = message.terminal_reason
          ? ` (${message.terminal_reason})`
          : "";
        const result = message.result.trim() ? `: ${message.result.trim()}` : "";
        throw new Error(`claude textgen returned no structured output${terminalReason}${result}`);
      }
      return message.structured_output;
    }
    // error_* subtype：errors 数组带 harness 原文（quota/auth 也在其中），
    // 原样上抛由 core 路由器决定降级，不在这里分类。
    throw new Error(`claude textgen failed (${message.subtype}): ${message.errors.join("; ")}`);
  }
  throw new Error("claude textgen stream ended without a result message");
}
