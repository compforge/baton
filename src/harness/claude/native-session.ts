import {
  getSessionInfo,
  getSessionMessages,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  NativeSessionInfo,
  NativeSessionProvider,
  NativeTranscriptEntry,
} from "../native-session.ts";

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

export function claudeTranscript(messages: SessionMessage[]): NativeTranscriptEntry[] {
  return messages.flatMap((message) => {
    if (message.type !== "user" && message.type !== "assistant") return [];
    const text = textContent(message.message);
    return text ? [{ role: message.type, text }] : [];
  });
}

export const claudeNativeSessions: NativeSessionProvider = {
  async inspect(sessionId): Promise<NativeSessionInfo | null> {
    const info = await getSessionInfo(sessionId);
    if (!info) return null;
    const messages = await getSessionMessages(sessionId, {
      ...(info.cwd ? { dir: info.cwd } : {}),
    });
    return {
      nativeSessionId: info.sessionId,
      cwd: info.cwd,
      title: info.customTitle || info.summary || info.firstPrompt,
      transcript: claudeTranscript(messages),
    };
  },
};
