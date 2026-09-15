import type { ContentBlock } from "../event/index.ts";
import type { InteractionAnswer, InteractionCancellationReason, InteractionDraft } from "../interaction/types.ts";

import type { ActorRef } from "@compforge/baton-plugin";
export type { ActorKind, ActorRef } from "@compforge/baton-plugin";

/**
 * @spec Message identity and authorship survive content updates, delivery receipts and replay.
 * Reply references describe interaction, never execution ownership or consumption.
 */
export interface MessageBase {
  messageId: string;
  source: ActorRef;
  target?: ActorRef;
  /** Omitted = unknown; [] = no specific reply target. */
  replyToMessageIds?: readonly string[];
  createdAt: string;
}

interface ContentMessage extends MessageBase {
  content: ContentBlock[];
}

export interface Input extends ContentMessage {
  kind: "input";
  role: "user";
}

export interface Output extends ContentMessage {
  kind: "output";
  role: "agent" | "thought";
  streamStatus?: "in_progress" | "completed";
}

export interface InputRequest extends MessageBase {
  kind: "input_request";
  target: ActorRef;
  request: InteractionDraft;
  status: "pending" | "answered" | "cancelled";
  expiresAt?: string;
  responseMessageId?: string;
  cancellation?: { reason: InteractionCancellationReason; detail?: string };
}

export interface InputResponse extends MessageBase {
  kind: "input_response";
  target: ActorRef;
  /** Exactly one request; a generic reply cannot authorize or settle it. */
  replyToMessageIds: readonly [string];
  answer: InteractionAnswer;
}

/** Interaction is a family of messages, not a third durable identity. */
export type Interaction = InputRequest | InputResponse;
export type Message = Input | Output | Interaction;
