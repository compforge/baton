import type {
  AskInput,
  AskResult,
  AskValue,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  DraftResult,
  HarnessInput,
  HarnessResult,
  ReconcileContext,
  ResourceRef,
  WithdrawInput,
  WithdrawResult,
} from "@compforge/baton-plugin";

import type { ReconcileSnapshot } from "./reconcile-snapshot.ts";
import type { ReconcileKey } from "./controller.ts";

export interface ReconcileVerbScope {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: number;
}

/**
 * Plugin-facing typed Core verbs. Every operation-producing verb first becomes
 * an Interaction; draft/harness create a HarnessInvocation only after that gate
 * settles positively. Runner never sends an opaque message.
 */
export type ReconcileVerbRequest =
  | {
      readonly verb: "ask";
      readonly input: AskInput;
    }
  | {
      readonly verb: "confirm";
      readonly input: ConfirmInput;
    }
  | {
      readonly verb: "withdraw";
      readonly input: WithdrawInput;
    }
  | {
      readonly verb: "draft";
      readonly input: DraftInput;
    }
  | {
      readonly verb: "harness";
      readonly input: HarnessInput;
    };

export type ReconcileVerbResponse =
  | AskResult
  | ConfirmResult
  | WithdrawResult
  | DraftResult
  | HarnessResult;

export type InvokeReconcileVerb = (
  context: ReconcileVerbScope,
  request: ReconcileVerbRequest,
) => Promise<ReconcileVerbResponse>;

const scopes = new WeakMap<ReconcileContext, ReconcileVerbScope>();

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateAsk(input: AskInput): void {
  nonEmpty("ask key", input.key);
  nonEmpty("ask title", input.title);
  nonEmpty("ask prompt", input.prompt);
  validateExpiresAt("ask", input.expiresAt);
  if (input.choices === undefined) {
    if (input.allowOther !== true) {
      throw new Error("ask without choices must set allowOther to true");
    }
    return;
  }
  if (input.choices.length === 0) {
    throw new Error("ask choices must not be empty");
  }
  const values = new Set<string>();
  for (const choice of input.choices) {
    nonEmpty("ask choice value", choice.value);
    nonEmpty("ask choice label", choice.label);
    if (values.has(choice.value)) {
      throw new Error(`ask choice value is duplicated: ${choice.value}`);
    }
    values.add(choice.value);
  }
}

function validateConfirm(input: ConfirmInput): void {
  nonEmpty("confirm key", input.key);
  nonEmpty("confirm title", input.title);
  nonEmpty("confirm prompt", input.prompt);
  if (input.confirmLabel !== undefined) {
    nonEmpty("confirm confirmLabel", input.confirmLabel);
  }
  if (input.declineLabel !== undefined) {
    nonEmpty("confirm declineLabel", input.declineLabel);
  }
  validateExpiresAt("confirm", input.expiresAt);
}

function validateExpiresAt(name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(
      `${name} expiresAt must be an ISO 8601 timestamp with a timezone`,
    );
  }
}

function validateWithdraw(input: WithdrawInput): void {
  nonEmpty("withdraw key", input.key);
  if (input.verb !== "ask" && input.verb !== "confirm") {
    throw new Error(`withdraw verb is invalid: ${String(input.verb)}`);
  }
}

function validateHarness(input: HarnessInput): void {
  nonEmpty("harness key", input.key);
  nonEmpty("harness prompt", input.prompt);
  nonEmpty("harness laneId", input.laneId);
  if (input.newLane !== undefined && typeof input.newLane !== "boolean") {
    throw new Error(`harness newLane is invalid: ${String(input.newLane)}`);
  }
  if (input.harnessTargetId !== undefined) {
    nonEmpty("harness harnessTargetId", input.harnessTargetId);
  }
}

function validateDraft(input: DraftInput): void {
  nonEmpty("draft key", input.key);
  nonEmpty("draft prompt", input.prompt);
  if (input.harnessTargetId !== undefined) {
    nonEmpty("draft harnessTargetId", input.harnessTargetId);
  }
}

/** Host and Runner use the same facade; only the invocation transport differs. */
export function createReconcileContext(
  snapshot: ReconcileSnapshot,
  scope: ReconcileVerbScope,
  invoke: InvokeReconcileVerb,
): ReconcileContext {
  const context = Object.freeze({
    snapshot,
    async ask<const TInput extends AskInput>(input: TInput) {
      validateAsk(input);
      return await invoke(scope, {
        verb: "ask",
        input,
      }) as AskResult<AskValue<TInput>>;
    },
    async confirm(input: ConfirmInput) {
      validateConfirm(input);
      return await invoke(scope, {
        verb: "confirm",
        input,
      }) as ConfirmResult;
    },
    async withdraw(input: WithdrawInput) {
      validateWithdraw(input);
      return await invoke(scope, {
        verb: "withdraw",
        input,
      }) as WithdrawResult;
    },
    async draft(input: DraftInput) {
      validateDraft(input);
      return await invoke(scope, {
        verb: "draft",
        input,
      }) as DraftResult;
    },
    async harness(input: HarnessInput) {
      validateHarness(input);
      return await invoke(scope, {
        verb: "harness",
        input,
      }) as HarnessResult;
    },
  });
  scopes.set(context, scope);
  return context;
}

export function reconcileScope(context: ReconcileContext): ReconcileVerbScope {
  const scope = scopes.get(context);
  if (!scope) throw new Error("reconcile scope is unavailable");
  return scope;
}

export function reconcileSnapshot(context: ReconcileContext): ReconcileSnapshot {
  return context.snapshot;
}
