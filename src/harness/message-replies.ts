import type { HarnessEvent } from "./event.ts";

/** Adapter-owned attribution: changing inputs must not retarget an already streaming message. */
export class MessageReplies {
  private readonly messages = new Map<string, readonly string[] | undefined>();

  constructor(public current?: readonly string[]) {}

  apply(event: HarnessEvent, explicit?: readonly string[]): HarnessEvent {
    if (event.kind !== "agent_message" && event.kind !== "agent_message_chunk" &&
        event.kind !== "agent_thought" && event.kind !== "agent_thought_chunk") return event;
    const { messageId } = event.payload;
    const replyToMessageIds = explicit ?? event.payload.replyToMessageIds;
    if (replyToMessageIds !== undefined) this.messages.set(messageId, [...new Set(replyToMessageIds)]);
    else if (!this.messages.has(messageId)) this.messages.set(messageId, this.current === undefined ? undefined : [...this.current]);
    const ids = this.messages.get(messageId);
    // Both message variants accept this field; their kind/content pairing is unchanged.
    return ids === undefined ? event : { ...event, payload: { ...event.payload, replyToMessageIds: ids } } as HarnessEvent;
  }
}
