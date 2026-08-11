import type {
  AskInput,
  AskResult,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  DraftResult,
  HarnessInput,
  HarnessResult,
  ReconcileContext,
  ResourceRef,
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
  if (input.choices === undefined) return;
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
}

function validateHarness(input: HarnessInput): void {
  nonEmpty("harness key", input.key);
  nonEmpty("harness prompt", input.prompt);
  if (input.lane !== "main" && input.lane !== "new") {
    throw new Error(`harness lane is invalid: ${String(input.lane)}`);
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
    async ask<const TValue extends string>(input: AskInput<TValue>) {
      validateAsk(input);
      return await invoke(scope, {
        verb: "ask",
        input,
      }) as AskResult<TValue>;
    },
    async confirm(input: ConfirmInput) {
      validateConfirm(input);
      return await invoke(scope, {
        verb: "confirm",
        input,
      }) as ConfirmResult;
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
