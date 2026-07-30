import { spawn } from "node:child_process";

import type {
  NativeSessionInfo,
  NativeSessionProvider,
  NativeTranscriptEntry,
} from "../native-session.ts";
import { codexLaunchCommand } from "./adapter.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const HISTORY_TURN_LIMIT = 50;

interface CodexNativePeer {
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
}

function missingThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread.*not found|no rollout found|session.*not found/i.test(message);
}

function textInputs(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" && item.text.trim()
        ? [item.text.trim()]
        : [];
    })
    .join("\n");
}

export function codexTranscript(turns: unknown[]): NativeTranscriptEntry[] {
  return turns.flatMap((rawTurn) => {
    const items = (rawTurn as { items?: unknown[] })?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((rawItem): NativeTranscriptEntry[] => {
      if (!rawItem || typeof rawItem !== "object") return [];
      const item = rawItem as Record<string, unknown>;
      if (item.type === "userMessage") {
        const text = textInputs(item.content);
        return text ? [{ role: "user" as const, text }] : [];
      }
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        return [{ role: "assistant" as const, text: item.text.trim() }];
      }
      return [];
    });
  });
}

async function readCodexTurns(peer: CodexNativePeer, sessionId: string): Promise<unknown[]> {
  const descending: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const turnsResponse = await peer.request(
      "thread/turns/list",
      {
        threadId: sessionId,
        limit: HISTORY_TURN_LIMIT,
        sortDirection: "desc",
        itemsView: "summary",
        ...(cursor ? { cursor } : {}),
      },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    const page = (turnsResponse as { data?: unknown[] })?.data;
    if (Array.isArray(page)) descending.push(...page);
    const nextCursor = (turnsResponse as { nextCursor?: unknown })?.nextCursor;
    if (typeof nextCursor !== "string" || !nextCursor) break;
    if (seenCursors.has(nextCursor)) {
      throw new Error(`codex thread/turns/list repeated cursor for ${sessionId}`);
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return descending.toReversed();
}

export async function inspectCodexSession(
  peer: CodexNativePeer,
  sessionId: string,
): Promise<NativeSessionInfo | null> {
  let response: unknown;
  try {
    response = await peer.request(
      "thread/read",
      { threadId: sessionId },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
  } catch (error) {
    if (missingThread(error)) return null;
    throw error;
  }
  const thread = (response as { thread?: Record<string, unknown> })?.thread;
  if (!thread || typeof thread.id !== "string") {
    throw new Error(`codex thread/read returned no thread for ${sessionId}`);
  }
  const turns = await readCodexTurns(peer, sessionId);
  return {
    nativeSessionId: thread.id,
    cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
    title:
      typeof thread.name === "string" && thread.name.trim()
        ? thread.name
        : typeof thread.preview === "string" && thread.preview.trim()
          ? thread.preview
          : undefined,
    transcript: codexTranscript(turns),
  };
}

export async function forkCodexSession(
  peer: CodexNativePeer,
  sessionId: string,
): Promise<string> {
  // excludeTurns 只省略 fork 响应中的 turn 数组；child 仍复制完整历史，
  // 随后由 thread/turns/list 分页读取，避免一次响应无界膨胀。
  const response = await peer.request(
    "thread/fork",
    { threadId: sessionId, excludeTurns: true },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  const threadId = (response as { thread?: { id?: unknown } })?.thread?.id;
  if (typeof threadId !== "string" || !threadId) {
    throw new Error(`codex thread/fork returned no thread id for ${sessionId}`);
  }
  return threadId;
}

async function withCodexPeer<T>(
  options: { command?: string[]; cwd: string },
  operation: (peer: CodexNativePeer) => Promise<T>,
): Promise<T> {
  const [command, ...args] = codexLaunchCommand(options.command);
  const child = spawn(command as string, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const peer = new JsonRpcPeer((line) => child.stdin.write(line));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => peer.feed(chunk));
  // 必须持续消费 stderr，否则 app-server 写满 pipe 后会反压阻塞只读请求。
  child.stderr.resume();
  child.once("error", (error) => peer.close(`codex app-server spawn error: ${error.message}`));
  child.once("close", (code) => peer.close(`codex app-server exited (${code})`));
  try {
    await peer.request(
      "initialize",
      {
        clientInfo: { name: "baton", version: "0.0.1", title: "baton" },
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    peer.notify("initialized", {});
    return await operation(peer);
  } finally {
    child.kill();
  }
}

export const codexNativeSessions: NativeSessionProvider = {
  inspect(sessionId, options) {
    return withCodexPeer(
      { command: options.config.codexCommand, cwd: options.cwd },
      (peer) => inspectCodexSession(peer, sessionId),
    );
  },

  fork(source, options) {
    return withCodexPeer(
      { command: options.config.codexCommand, cwd: source.cwd ?? options.cwd },
      (peer) => forkCodexSession(peer, source.nativeSessionId),
    );
  },
};
