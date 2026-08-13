/** A semantic input accepted from the Human boundary. */
export type HumanInput =
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

/** A Human Input after its received fact is durable in the Event Ledger. */
export interface HumanInputRecord {
  readonly inputId: string;
  readonly eventId: string;
  readonly seq: number;
  readonly input: HumanInput;
}

export type HumanInputOutcome = "succeeded" | "failed" | "cancelled";

/** The durable terminal fact for lowering one Human Input. */
export interface HumanInputSettlement {
  readonly inputId: string;
  readonly eventId: string;
  readonly seq: number;
  readonly outcome: HumanInputOutcome;
  readonly detail?: string;
}
