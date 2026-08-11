import type {
  AskInput,
  AskResult,
  Baton,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  DraftResult,
  HarnessInput,
  HarnessResult,
  ResourceRef,
} from "@compforge/baton-plugin";

import type { BatonSnapshot } from "./baton-snapshot.ts";
import type { ReconcileKey } from "./controller.ts";

export interface BatonVerbContext {
  readonly key: ReconcileKey;
  readonly resource: ResourceRef;
  readonly basedOnGeneration?: number;
  readonly basedOnResourceVersion?: string;
  readonly basedOnRevision?: number;
}

export type BatonVerbRequest =
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

export type BatonVerbResponse =
  | AskResult
  | ConfirmResult
  | DraftResult
  | HarnessResult;

export type InvokeBatonVerb = (
  context: BatonVerbContext,
  request: BatonVerbRequest,
) => Promise<BatonVerbResponse>;

const contexts = new WeakMap<Baton, BatonVerbContext>();

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateAsk(input: AskInput): void {
  nonEmpty("baton.ask key", input.key);
  nonEmpty("baton.ask title", input.title);
  nonEmpty("baton.ask prompt", input.prompt);
  if (input.choices === undefined) return;
  if (input.choices.length === 0) {
    throw new Error("baton.ask choices must not be empty");
  }
  const values = new Set<string>();
  for (const choice of input.choices) {
    nonEmpty("baton.ask choice value", choice.value);
    nonEmpty("baton.ask choice label", choice.label);
    if (values.has(choice.value)) {
      throw new Error(`baton.ask choice value is duplicated: ${choice.value}`);
    }
    values.add(choice.value);
  }
}

function validateConfirm(input: ConfirmInput): void {
  nonEmpty("baton.confirm key", input.key);
  nonEmpty("baton.confirm title", input.title);
  nonEmpty("baton.confirm prompt", input.prompt);
  if (input.confirmLabel !== undefined) {
    nonEmpty("baton.confirm confirmLabel", input.confirmLabel);
  }
  if (input.declineLabel !== undefined) {
    nonEmpty("baton.confirm declineLabel", input.declineLabel);
  }
}

function validateHarness(input: HarnessInput): void {
  nonEmpty("baton.harness key", input.key);
  nonEmpty("baton.harness prompt", input.prompt);
  if (input.lane !== "main" && input.lane !== "new") {
    throw new Error(`baton.harness lane is invalid: ${String(input.lane)}`);
  }
  if (input.harnessTargetId !== undefined) {
    nonEmpty("baton.harness harnessTargetId", input.harnessTargetId);
  }
}

function validateDraft(input: DraftInput): void {
  nonEmpty("baton.draft key", input.key);
  nonEmpty("baton.draft prompt", input.prompt);
  if (input.harnessTargetId !== undefined) {
    nonEmpty("baton.draft harnessTargetId", input.harnessTargetId);
  }
}

/** Host and Runner use the same facade; only the invocation transport differs. */
export function createBaton(
  snapshot: BatonSnapshot,
  context: BatonVerbContext,
  invoke: InvokeBatonVerb,
): Baton {
  const baton = Object.freeze({
    ...snapshot,
    async ask<const TValue extends string>(input: AskInput<TValue>) {
      validateAsk(input);
      return await invoke(context, {
        verb: "ask",
        input,
      }) as AskResult<TValue>;
    },
    async confirm(input: ConfirmInput) {
      validateConfirm(input);
      return await invoke(context, {
        verb: "confirm",
        input,
      }) as ConfirmResult;
    },
    async draft(input: DraftInput) {
      validateDraft(input);
      return await invoke(context, {
        verb: "draft",
        input,
      }) as DraftResult;
    },
    async harness(input: HarnessInput) {
      validateHarness(input);
      return await invoke(context, {
        verb: "harness",
        input,
      }) as HarnessResult;
    },
  });
  contexts.set(baton, context);
  return baton;
}

export function batonContext(baton: Baton): BatonVerbContext {
  const context = contexts.get(baton);
  if (!context) throw new Error("Baton reconcile context is unavailable");
  return context;
}

export function batonSnapshot(baton: Baton): BatonSnapshot {
  return Object.freeze({
    session: baton.session,
    activeTurns: baton.activeTurns,
    inputs: baton.inputs,
    harnessTargets: baton.harnessTargets,
    pendingInteractions: baton.pendingInteractions,
    ...(baton.latestTurn === undefined ? {} : { latestTurn: baton.latestTurn }),
    turns: baton.turns,
  });
}
