import type { Resource, ResourceType } from "./resource.ts";
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
  /**
   * Discovers missing Resources before this Source enqueues the Controller's
   * current Resource set. Status still converges through reconcile().
   */
  readonly discover?: () => Promise<void> | void;
}

export type ControllerSource = CronSource;

export interface Controller<TSpec, TStatus> {
  readonly resourceType: ResourceType;
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
