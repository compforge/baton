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

/** Minimal AbortSignal contract without imposing DOM or Node types on Plugins. */
export interface SourceSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface ResourceSourceContext<TSpec> {
  /** Aborted when the owning Controller registration closes. */
  readonly signal: SourceSignal;
  /**
   * Materializes one missing Resource owned by this Controller and enqueues its
   * stable key. Re-emitting the same seed is an idempotent wakeup.
   */
  emit(resource: {
    readonly name: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly spec: TSpec;
  }): void;
  /** Reports failures from callbacks that outlive start(). */
  reportError(error: unknown): void;
}

export interface ResourceSource<TSpec> {
  readonly type: "resource";
  /** Stable within one Controller. */
  readonly sourceId: string;
  /**
   * Performs the initial discovery and installs live subscriptions. Resolve
   * only after both are ready; keep long-lived work behind the abort signal.
   */
  start(
    context: ResourceSourceContext<TSpec>,
  ): Promise<void> | void;
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

export type ControllerSource<TSpec = Record<string, unknown>> =
  | CronSource
  | ResourceSource<TSpec>;

export interface Controller<TSpec, TStatus> {
  readonly resourceType: ResourceType;
  readonly sources?: readonly ControllerSource<TSpec>[];
  readonly maxConcurrency?: number;
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): Promise<ReconcileResult | void>;
  present?(
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): BoardPresentation | undefined;
}
