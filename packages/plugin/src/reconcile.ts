import type { Resource } from "./resource.ts";
import type { BatonSnapshot } from "./snapshot.ts";
import type { BoardPresentation } from "./board.ts";
import type { Output as InteractionOutput } from "./interaction.ts";

export type PluginOutput =
  | {
      readonly kind: "proposed-input";
      readonly text: string;
    }
  | InteractionOutput;

export interface ReconcileResult {
  readonly output?: PluginOutput;
  readonly requeueAfterMs?: number;
}

export interface CronSource {
  readonly type: "cron";
  /** Stable within one Controller. */
  readonly sourceId: string;
  /** Five- or six-field cron expression. */
  readonly cron: string;
  /** IANA time zone, for example "Asia/Shanghai" or "UTC". */
  readonly timeZone: string;
}

export type ControllerSource = CronSource;

export interface Controller<TSpec, TStatus> {
  readonly resourceKind: string;
  readonly sources?: readonly ControllerSource[];
  readonly maxConcurrency?: number;
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): Promise<ReconcileResult | void>;
  present?(
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): BoardPresentation | undefined;
}
