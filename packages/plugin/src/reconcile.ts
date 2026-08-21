import type { ResourceNamespace } from "./namespace.ts";
import type { Resource, ResourceType } from "./resource.ts";
import type { ReconcileContext } from "./reconcile-context.ts";
import type { BoardPresentation } from "./board.ts";
import type { ControllerSource } from "./source.ts";
import type { Watch } from "./watch.ts";

/** Identifies one primary Resource in the registering Controller's scope. */
export interface ReconcileRequest {
  readonly name: string;
  /** Primary Resource namespace. Defaults to the changed Resource namespace. */
  readonly namespace?: ResourceNamespace;
}

export interface ReconcileResult {
  readonly requeueAfterMs?: number;
}

export interface Controller<TSpec, TStatus> {
  readonly resourceType: ResourceType;
  readonly sources?: readonly ControllerSource<TSpec>[];
  readonly watches?: readonly Watch[];
  readonly maxConcurrency?: number;
  reconcile(
    context: ReconcileContext,
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): Promise<ReconcileResult | void>;
  present?(
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): Promise<BoardPresentation | undefined>;
}
