import type { InputRequestCreated } from "../../src/event/interaction.ts";
import type { ActorRef, InputResponse } from "../../src/message/types.ts";
import type { InteractionAnswer, InteractionDraft } from "../../src/interaction/types.ts";

export function requestMessage<T extends InteractionDraft>(
  messageId: string,
  request: T,
  source: ActorRef,
  options: Pick<InputRequestCreated, "expiresAt" | "pluginContext"> = {},
): InputRequestCreated & { request: T } {
  return {
    kind: "input_request", messageId, request, source, target: { kind: "user", key: "local" },
    status: "pending", createdAt: "2026-09-15T00:00:00Z", ...options,
  };
}

export function responseMessage(
  requestMessageId: string,
  answer: InteractionAnswer,
  target: ActorRef,
  options: Partial<Pick<InputResponse, "messageId" | "source">> = {},
): InputResponse {
  return {
    kind: "input_response", messageId: `${requestMessageId}-response`,
    source: { kind: "user", key: "local" }, target,
    replyToMessageIds: [requestMessageId], answer, createdAt: "2026-09-15T00:00:00Z", ...options,
  };
}
