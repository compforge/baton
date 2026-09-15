/**
 * A semantic Human operation normalized by a Baton View, not a Message.
 * Core may create a Message, change configuration or control execution from it.
 */
export type ViewInput =
  | {
      readonly kind: "configuration";
      readonly setting: "model_configuration";
      readonly harnessTargetId: string;
      readonly value: { readonly model: string; readonly effort: string };
    }
  | {
      readonly kind: "prompt";
      readonly text: string;
      readonly harnessTargetId: string;
    }
  | {
      readonly kind: "command";
      readonly command: string;
      readonly argument: string;
      readonly harnessTargetId: string;
    }
  | {
      readonly kind: "configuration";
      readonly setting: "harness" | "model" | "effort" | "mode";
      readonly harnessTargetId: string;
      readonly value: string | null;
    }
  | {
      readonly kind: "interaction_response";
      /** The InputRequest.messageId being answered or cancelled, not a response ID. */
      readonly messageId: string;
    }
  | {
      readonly kind: "task_action";
      readonly taskKey: string;
      readonly action: "stop";
    }
  | {
      readonly kind: "interrupt";
      readonly harnessTargetId?: string;
    };

/** A durably accepted operation; inputId identifies the operation, not a Message. */
export interface ViewInputRecord {
  readonly inputId: string;
  readonly eventId: string;
  readonly seq: number;
  readonly input: ViewInput;
}

/**
 * Notification that a projection update was published through a Baton View.
 * It carries no Message body and does not prove rendering, reading or completion.
 * One publication may cover multiple Messages, or only non-message view state.
 */
export interface ViewOutput {
  readonly outputId: string;
  readonly kind:
    | "transcript"
    | "queue"
    | "interaction"
    | "status"
    | "toast"
    | "board"
    | "picker";
  readonly revision?: number;
}
