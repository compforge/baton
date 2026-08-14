/**
 * Adapter 拥有的可持久化恢复状态。Baton 只负责按版本原样保存和回传，不解释 data。
 *
 * 内置 adapter 共享下面的 v1 session id codec，也可以在 data 中附带自己拥有的
 * cursor/checkpoint；Baton 无需理解这些字段或继续扩 OpenOptions。
 */
export interface HarnessResumeState {
  version: number;
  data: unknown;
}

export function sessionIdResumeState(sessionId: string): HarnessResumeState {
  return { version: 1, data: { sessionId } };
}

export function sessionIdFromResumeState(state: HarnessResumeState | undefined): string | undefined {
  if (state?.version !== 1 || !state.data || typeof state.data !== "object") return undefined;
  const sessionId = (state.data as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
