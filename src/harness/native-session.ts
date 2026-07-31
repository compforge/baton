import type { BatonConfig } from "../config/config.ts";
import { parseHarness, HARNESS_REGISTRY, resolveDefaultHarnessTarget } from "./registry.ts";
import type { HarnessTarget } from "./target.ts";
import type {
  HarnessHistoryBoundary,
  HarnessHistoryTurn as StoredHarnessHistoryTurn,
  SessionHandle,
  SessionStore,
} from "../store/store.ts";
import { harnessHistoryBoundary } from "../store/store.ts";
import type { HarnessSessionIdentity } from "./adapter.ts";

export interface HarnessTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export type HarnessHistoryTurn = StoredHarnessHistoryTurn;

export interface HarnessHistorySnapshot {
  /** HarnessTarget 内稳定的 HarnessSession identity。 */
  identity?: HarnessSessionIdentity;
  /** Inspector 观察到的完整前缀；resolve 后始终存在。 */
  observedThrough?: HarnessHistoryBoundary;
  cwd?: string;
  title?: string;
  /** 完整归一 Turn 优先；只提供文本历史的 Harness 可继续使用 transcript。 */
  turns?: HarnessHistoryTurn[];
  transcript?: HarnessTranscriptEntry[];
  /** @deprecated 0.2.14 第三方 Inspector 迁移兼容。 */
  nativeSessionId?: string;
}

export interface HarnessSessionInspectorOptions {
  config: BatonConfig;
  cwd: string;
}

/** Inspector 只读观察 HarnessSession；它不能启动、恢复或修改该会话。 */
export interface HarnessSessionInspector {
  inspect(
    sessionId: string,
    options: HarnessSessionInspectorOptions,
  ): Promise<HarnessHistorySnapshot | null>;
}

export interface ResolvedHarnessSession {
  target: HarnessTarget;
  harness: string;
  inspector: HarnessSessionInspector;
  snapshot: HarnessHistorySnapshot;
}

export interface HarnessSessionSource {
  target: HarnessTarget;
  harness: string;
  inspector: HarnessSessionInspector;
}

export interface HarnessSessionResolutionOptions extends HarnessSessionInspectorOptions {
  choose?: (
    matches: readonly ResolvedHarnessSession[],
  ) => Promise<ResolvedHarnessSession>;
  /** 测试/外部 registry 注入；生产缺省从 HARNESS_REGISTRY 收集。 */
  sources?: readonly HarnessSessionSource[];
}

function qualifiedReference(
  reference: string,
): { harness: string; sessionId: string } | null {
  const separator = reference.indexOf(":");
  if (separator < 0) return null;
  const harness = reference.slice(0, separator);
  const sessionId = reference.slice(separator + 1);
  if (!sessionId) throw new Error(`HarnessSession reference has no id: ${reference}`);
  return { harness, sessionId };
}

function registeredHarnessSessionSources(): HarnessSessionSource[] {
  return HARNESS_REGISTRY.flatMap((definition) => {
    if (!("sessionInspector" in definition)) return [];
    const target = resolveDefaultHarnessTarget(definition.id);
    if (!target) return [];
    return [{
      target,
      harness: definition.sessionKey,
      inspector: definition.sessionInspector,
    }];
  });
}

async function inspectSource(
  source: HarnessSessionSource,
  sessionId: string,
  options: HarnessSessionInspectorOptions,
): Promise<ResolvedHarnessSession | null> {
  const inspected = await source.inspector.inspect(sessionId, options);
  if (!inspected) return null;
  const identity = inspected.identity ?? (
    inspected.nativeSessionId ? { id: inspected.nativeSessionId } : undefined
  );
  if (!identity) {
    throw new Error(`${source.target.id} inspector returned a snapshot without identity`);
  }
  const turns = (inspected.turns ?? harnessHistoryTurns(inspected.transcript ?? [])).map(
    (turn, index) => ({ ...turn, turnId: turn.turnId ?? `history-${index + 1}` }),
  );
  const snapshot: HarnessHistorySnapshot = {
    ...inspected,
    identity,
    turns,
    observedThrough: inspected.observedThrough ?? harnessHistoryBoundary(turns),
  };
  return {
    ...source,
    snapshot,
  };
}

/**
 * 裸 id 只靠只读 inspect 自动识别；显式 `cx:` / `cc:` 则固定 provider。
 * 探测失败与 not-found 分开保留，避免把“命令不可用”谎报成“会话不存在”。
 */
export async function resolveHarnessSession(
  reference: string,
  options: HarnessSessionResolutionOptions,
): Promise<ResolvedHarnessSession> {
  const sources = options.sources ?? registeredHarnessSessionSources();
  const qualified = qualifiedReference(reference);
  if (qualified) {
    const harness = parseHarness(qualified.harness);
    if (!harness) throw new Error(`unknown HarnessSession harness: ${qualified.harness}`);
    const source = sources.find((candidate) => candidate.target.harness === harness);
    if (!source) throw new Error(`${harness} does not support HarnessSession lookup`);
    const match = await inspectSource(source, qualified.sessionId, options);
    if (!match) throw new Error(`${harness} HarnessSession not found: ${qualified.sessionId}`);
    return match;
  }

  const inspected = await Promise.allSettled(
    sources.map((source) =>
      inspectSource(source, reference, options),
    ),
  );
  const failures = inspected.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []
  );
  const matches = inspected.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  if (failures.length > 0 && matches.length > 0) {
    throw new Error(
      `HarnessSession lookup incomplete for ${reference}: ${failures.join("; ")}; use cx: or cc:`,
    );
  }
  if (failures.length > 0) {
    throw new Error(`HarnessSession lookup failed for ${reference}: ${failures.join("; ")}`);
  }
  if (matches.length === 1) return matches[0] as ResolvedHarnessSession;
  if (matches.length > 1) {
    if (options.choose) return options.choose(matches);
    const names = matches.map((match) => match.target.harness).join(", ");
    throw new Error(
      `HarnessSession id is ambiguous (${names}): ${reference}; use cx: or cc:`,
    );
  }
  throw new Error(`HarnessSession not found: ${reference}`);
}

/** 把 Harness 文本历史还原成 Baton 的逻辑 turn；连续 assistant 消息属于同一轮回复。 */
export function harnessHistoryTurns(
  transcript: readonly HarnessTranscriptEntry[],
): HarnessHistoryTurn[] {
  const turns: HarnessHistoryTurn[] = [];
  for (const entry of transcript) {
    if (entry.role === "user") {
      turns.push({ userText: entry.text });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) {
      turns.push({ agentText: entry.text });
      continue;
    }
    turn.agentText = turn.agentText
      ? `${turn.agentText}\n\n${entry.text}`
      : entry.text;
  }
  return turns;
}

export interface AdoptedHarnessSessionResult {
  session: SessionHandle;
  match: ResolvedHarnessSession;
  reused: boolean;
}

/** HarnessHistorySnapshot 先 adoption 为 BatonSession；后续 resume/fork 只走统一语义。 */
export function adoptHarnessSession(
  store: SessionStore,
  match: ResolvedHarnessSession,
  options: { cwd: string },
): AdoptedHarnessSessionResult {
  const identity = match.snapshot.identity ?? (
    match.snapshot.nativeSessionId ? { id: match.snapshot.nativeSessionId } : undefined
  );
  if (!identity) {
    throw new Error(`${match.target.id} returned an unresolved HarnessHistorySnapshot`);
  }
  const turns = (match.snapshot.turns ?? harnessHistoryTurns(match.snapshot.transcript ?? [])).map(
    (turn, index) => ({ ...turn, turnId: turn.turnId ?? `history-${index + 1}` }),
  );
  const observedThrough = match.snapshot.observedThrough ?? harnessHistoryBoundary(turns);
  const materialized = store.adoptHarnessSession({
    session: {
      harnessTargetId: match.target.id,
      harness: match.harness,
      identity,
    },
    cwd: match.snapshot.cwd ?? options.cwd,
    title: match.snapshot.title,
    turns,
    observedThrough,
  });
  return { ...materialized, match };
}

/** @deprecated 0.2.14 public API aliases. */
export type NativeTranscriptEntry = HarnessTranscriptEntry;
export type NativeSessionTurn = HarnessHistoryTurn;
export type NativeSessionInfo = HarnessHistorySnapshot;
export type NativeSessionProviderOptions = HarnessSessionInspectorOptions;
export type NativeSessionProvider = HarnessSessionInspector;
export type ResolvedNativeSession = ResolvedHarnessSession;
export type NativeSessionSource = HarnessSessionSource;
export type NativeSessionResolutionOptions = HarnessSessionResolutionOptions;
export type MaterializedNativeSession = AdoptedHarnessSessionResult;
export const resolveNativeSession = resolveHarnessSession;
export const nativeSessionTurns = harnessHistoryTurns;
export const materializeNativeSession = adoptHarnessSession;
