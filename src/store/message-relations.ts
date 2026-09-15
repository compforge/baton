import { textOf, type EventEnvelope } from "../event/index.ts";
import type { MessageState, SessionState } from "./reduce.ts";

/** @spec Reply references preserve unknown versus empty, are unique, and never infer consumption or reorder history. */
export function applyMessageReplies(
  state: SessionState,
  message: MessageState,
  ids: readonly string[] | undefined,
): void {
  if (ids === undefined) return;
  const unique = [...new Set(ids)];
  // A partial relation would falsely claim completeness. Keep the previous/unknown
  // relation if an adapter references a foreign, missing, or self message.
  if (unique.some((id) => id === message.messageId || !state.messages.has(id) && !state.harnessInputs.has(id))) return;
  message.replyToMessageIds = unique;
}

export function placeMessage(state: SessionState, id: string, beforeMessageId?: string): void {
  if (state.timeline.some((item) => item.type === "message" && item.id === id)) return;
  const anchor = beforeMessageId === undefined ? -1 : state.timeline.findIndex(
    (item) => item.type === "message" && item.id === beforeMessageId,
  );
  state.timeline.splice(anchor < 0 ? state.timeline.length : anchor, 0, { type: "message", id });
}

/**
 * @spec An unapplied steer has no transcript slot. Its first applied receipt assigns
 * actual execution ownership and position, even before the body or after Turn finalization.
 * Duplicate receipts cannot move it again or turn an applied input into a failed one.
 */
export function applyInputDelivery(state: SessionState, ev: EventEnvelope<"input_delivery_update">): void {
  const { messageId, state: outcome, beforeMessageId } = ev.payload;
  const input = state.harnessInputs.get(messageId);
  let message = state.messages.get(messageId);
  if (input?.deliveryOutcome === "applied" || message?.consumedAt !== undefined) return;
  if (input) {
    input.deliveryOutcome = outcome;
    if (outcome === "failed") input.status = "failed";
  }
  if (outcome === "applied") {
    if (!message) {
      message = { messageId, role: "user", content: input ? [...input.blocks] : [], delivery: "steer" };
      state.messages.set(messageId, message);
    }
    message.turnId = ev.turnId;
    message.harness = ev.harness;
    message.harnessTargetId = ev.harnessTargetId;
    message.laneId = ev.laneId;
    message.consumedAt = ev.seq;
    // Older ledgers may already have a hidden admission-time slot. Remove that
    // slot only on this first consumption, never on a duplicate receipt.
    const previous = state.timeline.findIndex((item) => item.type === "message" && item.id === messageId);
    if (previous >= 0 && message.delivery === "steer") state.timeline.splice(previous, 1);
    placeMessage(state, messageId, beforeMessageId);
  }
  if (message) message.deliveryState = outcome;
  if (outcome === "applied") refreshConsumedSummary(state, message?.turnId, ev.seq);
}

/** Shared by summary creation and late-consumption replay; pending inputs never enter Context. */
export function turnUserText(state: SessionState, turnId: string): string {
  const parts: string[] = [];
  for (const item of state.timeline) {
    if (item.type !== "message") continue;
    const message = state.messages.get(item.id);
    if (!message || message.role !== "user" || message.turnId !== turnId) continue;
    if (message.delivery === "steer") {
      const input = state.harnessInputs.get(message.messageId);
      if (input ? input.deliveryOutcome !== "applied" : message.deliveryState !== undefined && message.deliveryState !== "applied") continue;
    }
    const text = textOf(message.content);
    if (text) parts.push(text);
  }
  return parts.join("\n").replace(/<baton-(context|sync)>[\s\S]*?<\/baton-\1>\s*/g, "").trim();
}

export function refreshConsumedSummary(state: SessionState, turnId: string | undefined, seq: number): void {
  if (!turnId) return;
  const summary = state.turnSummaries.find((candidate) => candidate.turnId === turnId);
  if (!summary) return;
  const userText = turnUserText(state, turnId) || undefined;
  if (summary.userText === userText) return;
  // Keep the historical summary Event immutable. The read model includes later
  // facts and advances its Context cursor so an already-synced reader sees them.
  summary.userText = userText;
  summary.updatedSeq = seq;
}
