import type { InputRequest } from "../message/types.ts";
import type { InteractionCancellationReason, ReconcileInteractionContext } from "../interaction/types.ts";

/** Creation carries the Message itself; execution correlation belongs only to the fact. */
export type InputRequestCreated = InputRequest & {
  status: "pending";
  pluginContext?: ReconcileInteractionContext;
};

export interface InputRequestCancelled {
  messageId: string;
  reason: InteractionCancellationReason;
  detail?: string;
}
