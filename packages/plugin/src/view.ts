/** A semantic Human intent normalized by a Baton View. */
export type ViewInput =
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
      readonly interactionId: string;
    }
  | {
      readonly kind: "interrupt";
      readonly harnessTargetId?: string;
    };

/** A ViewInput after Core has durably accepted it. */
export interface ViewInputRecord {
  readonly inputId: string;
  readonly eventId: string;
  readonly seq: number;
  readonly input: ViewInput;
}

/** A Core projection update published through a Baton View. */
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
