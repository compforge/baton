import type { BatonConfig } from "../config/config.ts";
import { parseHarness, HARNESS_REGISTRY, resolveDefaultHarnessTarget } from "./registry.ts";
import type { HarnessTarget } from "./target.ts";
import type { SessionHandle, SessionStore } from "../store/store.ts";

export interface NativeTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface NativeSessionTurn {
  userText?: string;
  agentText?: string;
}

export interface NativeSessionInfo {
  nativeSessionId: string;
  cwd?: string;
  title?: string;
  transcript: NativeTranscriptEntry[];
}

export interface NativeSessionProviderOptions {
  config: BatonConfig;
  cwd: string;
}

/** Harness 私有发现/分叉停在 provider；core 只消费归一后的 metadata 与文本 turn。 */
export interface NativeSessionProvider {
  inspect(
    sessionId: string,
    options: NativeSessionProviderOptions,
  ): Promise<NativeSessionInfo | null>;
  fork(
    source: NativeSessionInfo,
    options: NativeSessionProviderOptions,
  ): Promise<string>;
}

export interface ResolvedNativeSession {
  target: HarnessTarget;
  harness: string;
  provider: NativeSessionProvider;
  source: NativeSessionInfo;
}

export interface NativeSessionSource {
  target: HarnessTarget;
  harness: string;
  provider: NativeSessionProvider;
}

export interface NativeSessionResolutionOptions extends NativeSessionProviderOptions {
  choose?: (
    matches: readonly ResolvedNativeSession[],
  ) => Promise<ResolvedNativeSession>;
  /** 测试/外部 registry 注入；生产缺省从 HARNESS_REGISTRY 收集。 */
  sources?: readonly NativeSessionSource[];
}

function qualifiedReference(
  reference: string,
): { harness: string; sessionId: string } | null {
  const separator = reference.indexOf(":");
  if (separator < 0) return null;
  const harness = reference.slice(0, separator);
  const sessionId = reference.slice(separator + 1);
  if (!sessionId) throw new Error(`native session reference has no id: ${reference}`);
  return { harness, sessionId };
}

function registeredNativeSessionSources(): NativeSessionSource[] {
  return HARNESS_REGISTRY.flatMap((definition) => {
    if (!("nativeSessions" in definition)) return [];
    const target = resolveDefaultHarnessTarget(definition.id);
    if (!target) return [];
    return [{
      target,
      harness: definition.sessionKey,
      provider: definition.nativeSessions,
    }];
  });
}

async function inspectSource(
  source: NativeSessionSource,
  sessionId: string,
  options: NativeSessionProviderOptions,
): Promise<ResolvedNativeSession | null> {
  const inspected = await source.provider.inspect(sessionId, options);
  if (!inspected) return null;
  return {
    ...source,
    source: inspected,
  };
}

/**
 * 裸 id 只靠只读 inspect 自动识别；显式 `cx:` / `cc:` 则固定 provider。
 * 探测失败与 not-found 分开保留，避免把“命令不可用”谎报成“会话不存在”。
 */
export async function resolveNativeSession(
  reference: string,
  options: NativeSessionResolutionOptions,
): Promise<ResolvedNativeSession> {
  const sources = options.sources ?? registeredNativeSessionSources();
  const qualified = qualifiedReference(reference);
  if (qualified) {
    const harness = parseHarness(qualified.harness);
    if (!harness) throw new Error(`unknown native session harness: ${qualified.harness}`);
    const source = sources.find((candidate) => candidate.target.harness === harness);
    if (!source) throw new Error(`${harness} does not support native session lookup`);
    const match = await inspectSource(source, qualified.sessionId, options);
    if (!match) throw new Error(`${harness} native session not found: ${qualified.sessionId}`);
    return match;
  }

  const inspected = await Promise.allSettled(
    sources.map((source) =>
      inspectSource(source, reference, options),
    ),
  );
  const matches = inspected.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : []
  );
  if (matches.length === 1) return matches[0] as ResolvedNativeSession;
  if (matches.length > 1) {
    if (options.choose) return options.choose(matches);
    const names = matches.map((match) => match.target.harness).join(", ");
    throw new Error(
      `native session id is ambiguous (${names}): ${reference}; use cx: or cc:`,
    );
  }
  const failures = inspected.flatMap((result) =>
    result.status === "rejected"
      ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
      : []
  );
  const detail = failures.length ? `; lookup errors: ${failures.join("; ")}` : "";
  throw new Error(`native session not found: ${reference}${detail}`);
}

/** 把 Harness 文本历史还原成 Baton 的逻辑 turn；连续 assistant 消息属于同一轮回复。 */
export function nativeSessionTurns(
  transcript: readonly NativeTranscriptEntry[],
): NativeSessionTurn[] {
  const turns: NativeSessionTurn[] = [];
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

export interface OpenedNativeSession {
  session: SessionHandle;
  match: ResolvedNativeSession;
  reused: boolean;
}

/** resume 外部会话时复用既有 Baton owner；首次接入才重建逻辑历史与原生绑定。 */
export function adoptNativeSession(
  store: SessionStore,
  match: ResolvedNativeSession,
  options: { cwd: string },
): OpenedNativeSession {
  const existing = store.findByNativeSession(match.target.id, match.source.nativeSessionId);
  if (existing) {
    return { session: store.openSession(existing.batonSessionId), match, reused: true };
  }
  const session = store.createFromNativeSession({
    harnessTargetId: match.target.id,
    harness: match.harness,
    sourceSessionId: match.source.nativeSessionId,
    nativeSessionId: match.source.nativeSessionId,
    mode: "resume",
    cwd: match.source.cwd ?? options.cwd,
    title: match.source.title,
    turns: nativeSessionTurns(match.source.transcript),
  });
  return { session, match, reused: false };
}

export async function forkNativeSession(
  store: SessionStore,
  match: ResolvedNativeSession,
  options: NativeSessionProviderOptions,
): Promise<OpenedNativeSession> {
  const forkedId = await match.provider.fork(match.source, options);
  const child = await match.provider.inspect(forkedId, {
    ...options,
    cwd: match.source.cwd ?? options.cwd,
  });
  if (!child) {
    throw new Error(
      `${match.target.harness} native fork ${forkedId} could not be read after creation`,
    );
  }
  const session = store.createFromNativeSession({
    harnessTargetId: match.target.id,
    harness: match.harness,
    sourceSessionId: match.source.nativeSessionId,
    nativeSessionId: forkedId,
    mode: "fork",
    cwd: child.cwd ?? match.source.cwd ?? options.cwd,
    title: child.title ?? match.source.title,
    turns: nativeSessionTurns(child.transcript),
  });
  return { session, match, reused: false };
}
