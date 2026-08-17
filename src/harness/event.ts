import type { AnyEventDraft } from "../event/index.ts";

/**
 * Adapter 已将原生流式观察归一、但 Core 尚未补齐可信坐标和持久化的
 * Harness 输出。Core 接受后才为它签发 eventId/seq，并作为 Baton Event 写入 Ledger。
 */
export type HarnessEvent = AnyEventDraft;

/** Adapter 在 open 期间绑定的 HarnessEvent 流式出口。 */
export type HarnessEventSink = (event: HarnessEvent) => void;
