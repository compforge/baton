import type { ActorRef, InputRequest, InputResponse } from "../message/types.ts";
import type { EventDraft } from "../event/index.ts";
import { newId } from "../event/ids.ts";
import type { SessionState } from "../store/reduce.ts";
import type { InteractionResult } from "./types.ts";
import { validInputResult } from "./answer.ts";

/** @spec Only a pending request can accept an authorized, typed resolution. */
export function canResolveRequest(request: InputRequest, result: InteractionResult, actor: ActorRef): boolean {
  return request.status === "pending"
    && (actor.kind === "user" || actor.kind === "baton")
    && validInputResult(request.request, result);
}

/** Prepare a typed fact; only Session commit may turn it into a decision. */
export function resolutionEvent(request: InputRequest, result: InteractionResult, actor: ActorRef):
  EventDraft<"interaction.answered"> | EventDraft<"interaction.cancelled"> | undefined {
  if (!canResolveRequest(request, result, actor)) return undefined;
  if (result.kind === "cancelled") {
    return { kind: "interaction.cancelled", payload: {
      messageId: request.messageId, reason: result.reason,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    } };
  }
  const response: InputResponse = {
    kind: "input_response", messageId: newId("m"), createdAt: new Date().toISOString(),
    source: actor, target: request.source, replyToMessageIds: [request.messageId], answer: result,
  };
  return { kind: "interaction.answered", payload: response };
}

/** Continuations read the committed decision; they never reduce terminal facts themselves. */
export function requestResult(state: SessionState, messageId: string): InteractionResult | undefined {
  const request = state.interactions.get(messageId)?.request;
  if (request?.status === "cancelled" && request.cancellation) {
    return { kind: "cancelled", ...request.cancellation };
  }
  if (request?.status === "answered" && request.responseMessageId) {
    return state.inputResponses.get(request.responseMessageId)?.answer;
  }
  return undefined;
}
