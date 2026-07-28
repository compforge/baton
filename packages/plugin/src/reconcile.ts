import type { Resource, ResourceType } from "./resource.ts";
import type { BatonSnapshot } from "./snapshot.ts";
import type { BoardPresentation } from "./board.ts";
import type { Output as InteractionOutput } from "./interaction.ts";
import type { ControllerSource } from "./source.ts";
import type { Watch } from "./watch.ts";

/** Identifies one primary Resource in the registering Controller's scope. */
export interface ReconcileRequest {
  readonly name: string;
}

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

export interface Controller<TSpec, TStatus> {
  readonly resourceType: ResourceType;
  readonly sources?: readonly ControllerSource<TSpec>[];
  readonly watches?: readonly Watch[];
  readonly maxConcurrency?: number;
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): Promise<ReconcileResult | void>;
  present?(
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): BoardPresentation | undefined;
}
