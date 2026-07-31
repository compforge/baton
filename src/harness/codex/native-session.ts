import { spawn } from "node:child_process";

import type {
  HarnessHistorySnapshot,
  HarnessHistoryTurn,
  HarnessSessionInspector,
  HarnessTranscriptEntry,
} from "../native-session.ts";
import { harnessHistoryBoundary } from "../../store/store.ts";
import {
  codexItemLifecycleDrafts,
  codexLaunchCommand,
} from "./adapter.ts";
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

export function codexTranscript(turns: unknown[]): HarnessTranscriptEntry[] {
  return turns.flatMap((rawTurn) => {
    const items = (rawTurn as { items?: unknown[] })?.items;
    if (!Array.isArray(items)) return [];
    return items.flatMap((rawItem): HarnessTranscriptEntry[] => {
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

function codexStopReason(status: string): string {
  return status === "completed"
    ? "end_turn"
    : status === "interrupted"
      ? "cancelled"
      : status;
}

/** app-server full Turn → 与 live Codex adapter 同构的 Baton turn。 */
export function codexHistoryTurns(turns: unknown[]): HarnessHistoryTurn[] {
  return turns.map((rawTurn, index) => {
    const turn = (rawTurn ?? {}) as Record<string, unknown>;
    const items = Array.isArray(turn.items) ? turn.items : [];
    const status = String(turn.status ?? "");
    if (status === "inProgress") {
      throw new Error(`codex native session has an in-progress turn at position ${index + 1}`);
    }
    if (turn.itemsView !== undefined && turn.itemsView !== "full") {
      throw new Error(`codex native turn ${String(turn.id ?? index + 1)} is not a full history view`);
    }

    const events: NonNullable<HarnessHistoryTurn["events"]> = [];
    const userTexts: string[] = [];
    const agentTexts: string[] = [];
    let running = false;
    const pushRunning = () => {
      if (running) return;
      running = true;
      events.push({
        source: "baton",
        event: {
          kind: "state_update",
          payload: { state: "running" },
        },
      });
    };

    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      if (item.type === "userMessage") {
        const text = textInputs(item.content);
        if (!text) continue;
        userTexts.push(text);
        events.push({
          source: "user",
          event: {
            kind: "user_message",
            payload: {
              messageId: String(item.id ?? `native-user-${index}`),
              content: [{ type: "text", text }],
            },
            raw: item,
          },
        });
        pushRunning();
        continue;
      }

      pushRunning();
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        agentTexts.push(item.text.trim());
      }
      for (const lifecycle of ["started", "completed"] as const) {
        for (const event of codexItemLifecycleDrafts(lifecycle, item)) {
          events.push({ source: "harness", event: { ...event, raw: item } });
        }
      }
    }
    pushRunning();

    const error = turn.error;
    if (status === "failed" && error && typeof error === "object") {
      const detail = error as Record<string, unknown>;
      events.push({
        source: "harness",
        event: {
          kind: "_baton_error_update",
          payload: {
            message: String(detail.message ?? "Codex turn failed"),
            ...(typeof detail.codexErrorInfo === "string"
              ? { code: detail.codexErrorInfo }
              : {}),
          },
          raw: error,
        },
      });
    }
    events.push({
      source: "harness",
      event: {
        kind: "state_update",
        payload: {
          state: "idle",
          stopReason: codexStopReason(status || "completed"),
        },
        raw: rawTurn,
      },
    });
    return {
      turnId: String(turn.id ?? `history-${index + 1}`),
      userText: userTexts.join("\n") || undefined,
      agentText: agentTexts.join("\n") || undefined,
      events,
    };
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
        itemsView: "full",
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
): Promise<HarnessHistorySnapshot | null> {
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
  const history = codexHistoryTurns(turns);
  return {
    identity: { id: thread.id },
    cwd: typeof thread.cwd === "string" ? thread.cwd : undefined,
    title:
      typeof thread.name === "string" && thread.name.trim()
        ? thread.name
        : typeof thread.preview === "string" && thread.preview.trim()
          ? thread.preview
          : undefined,
    turns: history,
    observedThrough: harnessHistoryBoundary(history),
  };
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
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    // 物化前还没有 BatonSession 日志；保留有界尾部，在发现失败时带回诊断。
    stderr = `${stderr}${chunk}`.slice(-4096);
  });
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim();
    throw new Error(detail ? `${message}; codex stderr: ${detail}` : message, { cause: error });
  } finally {
    child.kill();
  }
}

export const codexSessionInspector: HarnessSessionInspector = {
  inspect(sessionId, options) {
    return withCodexPeer(
      { command: options.config.codexCommand, cwd: options.cwd },
      (peer) => inspectCodexSession(peer, sessionId),
    );
  },
};

/** @deprecated 使用 codexHistoryTurns / codexSessionInspector。 */
export const codexNativeTurns = codexHistoryTurns;
export const codexNativeSessions = codexSessionInspector;
