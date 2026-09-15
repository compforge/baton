import type { SessionState } from "../store/reduce.ts";
import type { ProjectedMessage } from "../store/message-state.ts";

/** One address space over the existing specialized projections, not another message store. */
export function getMessage(state: SessionState, messageId: string): ProjectedMessage | undefined {
  return state.messages.get(messageId)
    ?? state.interactions.get(messageId)?.request
    ?? state.inputResponses.get(messageId);
}
