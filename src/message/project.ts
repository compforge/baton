import type { EventEnvelope, EventSource } from "../event/index.ts";
import type { HarnessInputSource } from "../harness/input.ts";
import { actorOf, HUMAN_ACTOR } from "./actor.ts";
import type { ActorRef, Input, InputRequest } from "./types.ts";
import type { InputRequestState, InputResponseState } from "../store/message-state.ts";
import { newId } from "../event/ids.ts";
import type { InteractionDraft } from "../interaction/types.ts";

export function createInputRequest(request: InteractionDraft, source: ActorRef, expiresAt?: string): InputRequest & { status: "pending" } {
  return {
    kind: "input_request", messageId: newId("m"), source, target: { ...HUMAN_ACTOR },
    createdAt: new Date().toISOString(), request, status: "pending",
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** A Harness reporting consumption is not the author of the user's input. */
export function inputAuthor(source?: HarnessInputSource | EventSource): ActorRef {
  return source?.type === "plugin" || source?.type === "user"
    ? actorOf(source) : { ...HUMAN_ACTOR };
}

export function inputMessage(
  messageId: string,
  createdAt: string,
  source?: HarnessInputSource | EventSource,
  targetId?: string,
): Input {
  return {
    kind: "input", messageId, role: "user", content: [], createdAt,
    source: inputAuthor(source),
    ...(targetId === undefined ? {} : { target: { kind: "harness", key: targetId } }),
  };
}

/** Facts carry Message identity and actors; only execution coordinates come from the envelope. */
export function inputRequestMessage(event: EventEnvelope<"interaction.requested">): InputRequestState {
  const { pluginContext, ...request } = event.payload;
  return {
    ...request,
    turnId: event.turnId,
    laneId: event.laneId,
  };
}

export function inputResponseMessage(
  event: EventEnvelope<"interaction.answered">,
): InputResponseState {
  return {
    ...event.payload,
    turnId: event.turnId,
    laneId: event.laneId,
  };
}
