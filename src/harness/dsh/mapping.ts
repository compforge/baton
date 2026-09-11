import type {
  ContentBlock,
  StopReason,
  ToolEffect,
  ToolKind,
  UsageUpdate,
} from "../../event/index.ts";
import { newId } from "../../event/ids.ts";
import { READ_ONLY_COMMAND_RULES } from "../command-effect/rules.ts";
import { shellCommandIsReadOnly } from "../command-effect/shell.ts";
import {
  type HarnessResumeState,
  sessionIdResumeState,
} from "../resume.ts";
import { kindEffect } from "../tool-effect.ts";

export interface DshRequestContext {
  readonly model: string;
  readonly contextWindow?: number;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** DSH persists tool arguments as JSON text; normalize them at the wire boundary. */
export function toolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return record(parsed) ?? value;
  } catch {
    // Streaming argument fragments are intentionally retained until valid JSON arrives.
    return value;
  }
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function textBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const block = record(candidate);
    return block?.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: block.text } satisfies ContentBlock]
      : [];
  });
}

export function reasoningBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const block = record(candidate);
    return block?.type === "reasoning" && typeof block.text === "string"
      ? [{ type: "text", text: block.text } satisfies ContentBlock]
      : [];
  });
}

export function contentText(value: unknown): string {
  return textBlocks(value)
    .map((block) => text(record(block)?.text))
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

export function usagePayload(value: unknown): UsageUpdate | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const mapped: UsageUpdate = {
    inputTokens: finiteNumber(usage.inputTokens),
    outputTokens: finiteNumber(usage.outputTokens),
    cacheReadTokens: finiteNumber(usage.cacheReadTokens),
    cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
    reasoningTokens: finiteNumber(usage.reasoningTokens),
  };
  return Object.values(mapped).some((count) => count !== undefined) ? mapped : undefined;
}

export function contextUsed(usage: UsageUpdate | undefined): number | undefined {
  if (usage?.inputTokens === undefined) return undefined;
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

export function requestContextFromResumeState(
  state: HarnessResumeState | undefined,
): DshRequestContext | undefined {
  if (state?.version !== 1) return undefined;
  const data = record(state.data);
  const requestContext = record(data?.requestContext);
  const model = text(requestContext?.model);
  if (!model) return undefined;
  const contextWindow = finiteNumber(requestContext?.contextWindow);
  return {
    model,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

export function dshResumeState(
  sessionId: string,
  requestContext?: DshRequestContext,
): HarnessResumeState {
  if (!requestContext) return sessionIdResumeState(sessionId);
  return {
    version: 1,
    data: { sessionId, requestContext },
  };
}

export function dshStopReason(reason: unknown): StopReason {
  const kind = text(record(reason)?.kind);
  switch (kind) {
    case "completed":
      return "end_turn";
    case "max-tokens":
      return "max_tokens";
    case "aborted":
    case "interrupted":
      return "cancelled";
    case "blocked":
      return "refusal";
    case "error":
      return "error";
    default:
      return (kind ?? "unknown") as StopReason;
  }
}

export function dshFailure(reason: unknown): { code?: string; message: string } | undefined {
  const error = record(record(reason)?.error);
  const message = text(error?.message);
  if (!message) return undefined;
  const code = text(error?.code);
  return { ...(code ? { code } : {}), message };
}

export function nativeStepKey(data: Record<string, unknown>): string {
  return `${String(data.turn ?? "unknown")}:${String(data.step ?? "unknown")}`;
}

export function mappedId(map: Map<string, string>, nativeId: string, prefix: "m" | "tc"): string {
  const existing = map.get(nativeId);
  if (existing) return existing;
  const id = newId(prefix);
  map.set(nativeId, id);
  return id;
}

export function toolKind(name: string): ToolKind {
  const normalized = name.toLowerCase();
  if (/read|cat|view/.test(normalized)) return "read";
  if (/write|edit|patch/.test(normalized)) return "edit";
  if (/grep|glob|search|find/.test(normalized)) return "search";
  if (/bash|shell|terminal|exec|run/.test(normalized)) return "execute";
  if (/fetch|http|web/.test(normalized)) return "fetch";
  return "other";
}

/** DSH only supplies raw tool arguments, so prove shell reads with Baton's shared recognizer. */
export function toolEffect(name: string, input: unknown): ToolEffect | undefined {
  const kind = toolKind(name);
  const direct = kindEffect(kind);
  if (direct) return direct;
  if (kind !== "execute") return undefined;
  const command = text(record(input)?.command);
  return command && shellCommandIsReadOnly(command, READ_ONLY_COMMAND_RULES)
    ? "read"
    : undefined;
}
