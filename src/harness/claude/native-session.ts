import {
  getSessionInfo,
  getSessionMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  NativeSessionInfo,
  NativeSessionProvider,
  NativeSessionTurn,
  NativeTranscriptEntry,
} from "../native-session.ts";
import {
  claudeDurableMessageDrafts,
  type ClaudeDurableMappingState,
} from "./adapter.ts";

function stripBatonInjectedContext(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*?<\/baton-\1>\s*/g, "").trim();
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    })
    .join("\n");
}

function directTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    })
    .join("");
}

function durableBlocks(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const content = (value as { content?: unknown }).content;
  return Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
}

export function claudeTranscript(messages: SessionMessage[]): NativeTranscriptEntry[] {
  return messages.flatMap((message) => {
    if (message.type !== "user" && message.type !== "assistant") return [];
    const text = textContent(message.message);
    return text ? [{ role: message.type, text }] : [];
  });
}

interface ClaudeNativeTurnBuilder {
  turnId: string;
  userTexts: string[];
  agentTexts: string[];
  events: NonNullable<NativeSessionTurn["events"]>;
  running: boolean;
}

/** Claude getSessionMessages durable history → 与 live adapter 同构的 Baton turns。 */
export function claudeNativeTurns(messages: SessionMessage[]): NativeSessionTurn[] {
  const turns: NativeSessionTurn[] = [];
  const state: ClaudeDurableMappingState = {
    suppressedToolIds: new Set(),
    capturedProposedPlanKeys: new Set(),
    tasks: new Map(),
    pendingTaskOps: new Map(),
  };
  let current: ClaudeNativeTurnBuilder | undefined;

  const startTurn = (): ClaudeNativeTurnBuilder => ({
    turnId: `native-${turns.length + 1}`,
    userTexts: [],
    agentTexts: [],
    events: [],
    running: false,
  });
  const ensureTurn = (): ClaudeNativeTurnBuilder =>
    (current ??= startTurn());
  const pushRunning = (turn: ClaudeNativeTurnBuilder): void => {
    if (turn.running) return;
    turn.running = true;
    turn.events.push({
      source: "baton",
      event: { kind: "state_update", payload: { state: "running" } },
    });
  };
  const flush = (): void => {
    if (!current) return;
    pushRunning(current);
    current.events.push({
      source: "harness",
      event: {
        kind: "state_update",
        payload: { state: "idle", stopReason: "end_turn" },
      },
    });
    turns.push({
      userText: current.userTexts.join("\n") || undefined,
      agentText: current.agentTexts.join("\n") || undefined,
      events: current.events,
    });
    current = undefined;
  };

  for (const message of messages) {
    if (message.type !== "user" && message.type !== "assistant") continue;
    const userText =
      message.type === "user"
        ? stripBatonInjectedContext(directTextContent(message.message))
        : "";
    if (userText) {
      flush();
      const turn = ensureTurn();
      turn.userTexts.push(userText);
      turn.events.push({
        source: "user",
        event: {
          kind: "user_message",
          payload: {
            messageId: message.uuid,
            content: [{ type: "text", text: userText }],
          },
          raw: message,
        },
      });
      pushRunning(turn);
    }

    const blocks = durableBlocks(message.message);
    const hasDurableActivity =
      message.type === "assistant"
        ? blocks.some((block) =>
            block.type === "thinking" ||
            block.type === "text" ||
            block.type === "tool_use"
          )
        : blocks.some((block) => block.type === "tool_result");
    // 纯注入上下文在剥离后可能为空；不能为它伪造一个空 observed turn。
    if (!userText && !hasDurableActivity) continue;

    const turn = ensureTurn();
    pushRunning(turn);
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      const agentText = directTextContent(message.message);
      if (agentText) turn.agentTexts.push(agentText);
    }
    for (const event of claudeDurableMessageDrafts(
      state,
      message,
      {
        turnId: turn.turnId,
        messageId: message.uuid,
        raw: message,
      },
    )) {
      turn.events.push({ source: "harness", event });
    }
  }
  flush();
  return turns;
}

export const claudeNativeSessions: NativeSessionProvider = {
  async inspect(sessionId, options): Promise<NativeSessionInfo | null> {
    const info = await getSessionInfo(sessionId);
    const messages = await getSessionMessages(sessionId, {
      ...(info?.cwd ? { dir: info.cwd } : { dir: options.cwd }),
    });
    // getSessionInfo 会跳过“没有可提取 summary”的有效 transcript；消息读取才是存在性兜底。
    if (!info && messages.length === 0) return null;
    return {
      nativeSessionId: info?.sessionId ?? sessionId,
      cwd: info?.cwd ?? options.cwd,
      title:
        info?.customTitle ||
        info?.summary ||
        (info?.firstPrompt ? stripBatonInjectedContext(info.firstPrompt) : undefined),
      turns: claudeNativeTurns(messages),
    };
  },
};
