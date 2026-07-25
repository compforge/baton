export type PluginConfig = Record<string, unknown>;

export interface PluginInstance {
  readonly pluginInstanceId: string;
  readonly batonSessionId: string;
  readonly pluginId: string;
  readonly packageVersion: string;
  readonly enabled: boolean;
  readonly config: Readonly<PluginConfig>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginResourceMetadata {
  readonly resourceId: string;
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly generation: number;
  readonly resourceVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextReconcileAt?: string;
}

export interface PluginResource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> {
  readonly kind: string;
  readonly metadata: PluginResourceMetadata;
  readonly spec: TSpec;
  readonly status: TStatus;
}

export interface PluginResourceClient {
  get<TSpec, TStatus>(
    resourceKind: string,
    resourceId: string,
  ): Readonly<PluginResource<TSpec, TStatus>>;
  list<TSpec, TStatus>(
    resourceKind?: string,
  ): readonly Readonly<PluginResource<TSpec, TStatus>>[];
  create<TSpec, TStatus>(
    resourceKind: string,
    init: {
      resourceId: string;
      spec: TSpec;
    },
  ): Readonly<PluginResource<TSpec, TStatus>>;
  delete(resourceKind: string, resourceId: string): void;
  patchStatus<TSpec, TStatus>(
    resource: Readonly<PluginResource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Readonly<PluginResource<TSpec, TStatus>>;
}

export type PluginOutput = {
  readonly kind: "proposed-input";
  readonly text: string;
};

export type SessionRunState = "running" | "idle" | "requires_action";
export type InputStatus =
  | "queued"
  | "admitted"
  | "accepted_steer"
  | "finalized"
  | "recalled"
  | "interrupted";
export type InteractionRequester =
  | { readonly type: "harness"; readonly harnessTargetId: string }
  | { readonly type: "plugin"; readonly pluginInstanceId: string }
  | { readonly type: "baton" };

export interface TurnSummaryToolCall {
  readonly toolCallId: string;
  readonly title?: string;
  readonly kind?: string;
  readonly status?: string;
}

export interface TurnSummary {
  readonly turnId: string;
  readonly stopReason?: string;
  readonly userText?: string;
  readonly agentText?: string;
  readonly toolCalls: readonly TurnSummaryToolCall[];
  readonly usage?: Readonly<{
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    isEstimated?: boolean;
  }>;
  readonly startedAt?: string;
  readonly endedAt?: string;
}

export interface BatonSessionSnapshot {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly runState: SessionRunState;
  readonly revision: number;
}

export interface BatonActiveTurnSnapshot {
  readonly turnId: string;
  readonly role: "driven" | "observed";
  readonly state: "running" | "requires_action";
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly startedAt?: number;
}

export interface BatonInputSnapshot {
  readonly messageId: string;
  readonly turnId: string;
  readonly harnessTargetId: string;
  readonly harness: string;
  readonly status: InputStatus;
  readonly delivery: "prompt" | "steer";
}

export interface BatonHarnessTargetSnapshot {
  readonly id: string;
  readonly harness: string;
  readonly label?: string;
}

export interface BatonPendingInteractionSnapshot {
  readonly interactionId: string;
  readonly kind: "permission" | "question" | "hook_trust";
  readonly requester: InteractionRequester;
  readonly turnId?: string;
}

export interface BatonSnapshot {
  readonly session: BatonSessionSnapshot;
  readonly activeTurns: readonly BatonActiveTurnSnapshot[];
  readonly inputs: readonly BatonInputSnapshot[];
  readonly harnessTargets: readonly BatonHarnessTargetSnapshot[];
  readonly pendingInteractions: readonly BatonPendingInteractionSnapshot[];
  readonly latestTurn?: TurnSummary;
  readonly turns: readonly TurnSummary[];
}

export interface ReconcileResult {
  readonly output?: PluginOutput;
  readonly requeueAfterMs?: number;
}

export interface ResourceReconciler<TResource> {
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<TResource>,
  ): Promise<ReconcileResult | void>;
}

export type Reconciler<TSpec, TStatus> = ResourceReconciler<
  PluginResource<TSpec, TStatus>
>;

export type BatonTurnResourceKind = "baton.turn";

export type BatonTurnResourceData = TurnSummary & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
};

export interface BuiltinResourceDataMap {
  "baton.turn": BatonTurnResourceData;
}

export type BuiltinResourceKind = keyof BuiltinResourceDataMap;

export interface BuiltinResourceMetadata {
  readonly batonSessionId: string;
  readonly resourceId: string;
  readonly revision: number;
  readonly sourceEventId: string;
  readonly observedAt: string;
}

export interface BuiltinResource<
  K extends BuiltinResourceKind = BuiltinResourceKind,
> {
  readonly kind: K;
  readonly metadata: BuiltinResourceMetadata;
  readonly data: BuiltinResourceDataMap[K];
}

export type BuiltinReconciler<K extends BuiltinResourceKind> =
  ResourceReconciler<BuiltinResource<K>>;

export interface ResourceContribution<TSpec, TStatus> {
  readonly resourceKind: string;
  readonly reconciler: Reconciler<TSpec, TStatus>;
  readonly maxConcurrency?: number;
}

export interface BuiltinResourceContribution<
  K extends BuiltinResourceKind,
> {
  readonly resourceKind: K;
  readonly reconciler: BuiltinReconciler<K>;
  readonly maxConcurrency?: number;
}

export interface PluginSessionContext {
  readonly batonSessionId: string;
  readonly cwd?: string;
}

export interface PluginActivationContext {
  readonly instance: PluginInstance;
  readonly session: PluginSessionContext;
  readonly resources: PluginResourceClient;
  registerResource<TSpec, TStatus>(
    contribution: ResourceContribution<TSpec, TStatus>,
  ): void;
  watchBuiltinResource<K extends BuiltinResourceKind>(
    contribution: BuiltinResourceContribution<K>,
  ): void;
  onClose(cleanup: () => Promise<void> | void): void;
}

export interface PluginPackage {
  readonly pluginId: string;
  readonly version: string;
  activate(context: PluginActivationContext): Promise<void> | void;
}
