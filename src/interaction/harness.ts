import type { InteractionContext } from "../harness/adapter.ts";
import { newId } from "../event/ids.ts";
import type { AnyEventDraft, EventSource } from "../event/types.ts";
import type {
  Interaction,
  InteractionDraft,
  InteractionResult,
} from "./types.ts";

interface HarnessInteractionBinding {
  target: { id: string };
  laneId: string;
}

type AppendEvent<TBinding> = (
  binding: TBinding,
  event: AnyEventDraft,
  source: EventSource,
) => void;

/**
 * Harness 请求的进程内 continuation。Core 仍先持久化 Interaction 生命周期，
 * 这里才把终态交还给正在等待的 Adapter。
 */
export class HarnessInteractionContinuations<
  TBinding extends HarnessInteractionBinding,
> {
  private readonly pending = new Map<
    string,
    {
      interaction: Interaction;
      binding: TBinding;
      turnId?: string;
      resolve: (result: InteractionResult) => void;
    }
  >();

  constructor(
    private readonly appendEvent: AppendEvent<TBinding>,
    private readonly changed: () => void,
  ) {}

  open(
    binding: TBinding,
    draft: InteractionDraft,
    turnId: string | undefined,
    context?: InteractionContext,
  ): Promise<InteractionResult> {
    const harnessTargetId = binding.target.id;
    const interaction: Interaction = {
      ...draft,
      interactionId: newId("ix"),
      requester: {
        type: "harness",
        harnessTargetId,
        laneId: binding.laneId,
      },
    };

    return new Promise((resolve, reject) => {
      this.pending.set(interaction.interactionId, {
        interaction,
        binding,
        turnId,
        resolve,
      });
      try {
        this.appendEvent(
          binding,
          {
            kind: "interaction.requested",
            ...(turnId ? { turnId } : {}),
            payload: interaction,
            ...(context?.raw !== undefined ? { raw: context.raw } : {}),
          },
          { type: "harness", harnessTargetId },
        );
      } catch (error) {
        this.pending.delete(interaction.interactionId);
        reject(error);
        return;
      }
      this.changed();
    });
  }

  complete(interactionId: string, result: InteractionResult): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    if (result.kind !== "cancelled" && result.kind !== entry.interaction.kind) return false;
    return this.settle(interactionId, result, { type: "user" });
  }

  cancelForTurn(turnId: string): void {
    for (const [interactionId, entry] of this.pending) {
      if (entry.turnId !== turnId) continue;
      this.settle(
        interactionId,
        { kind: "cancelled", reason: "turn" },
        { type: "baton" },
      );
    }
  }

  private settle(
    interactionId: string,
    result: InteractionResult,
    source: EventSource,
  ): boolean {
    const entry = this.pending.get(interactionId);
    if (!entry) return false;
    const turn = entry.turnId ? { turnId: entry.turnId } : {};
    if (result.kind === "cancelled") {
      this.appendEvent(
        entry.binding,
        {
          kind: "interaction.cancelled",
          ...turn,
          payload: {
            interactionId,
            reason: result.reason,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          },
        },
        source,
      );
    } else {
      this.appendEvent(
        entry.binding,
        {
          kind: "interaction.answered",
          ...turn,
          payload: { interactionId, answer: result },
        },
        source,
      );
    }
    this.pending.delete(interactionId);
    entry.resolve(result);
    return true;
  }
}
