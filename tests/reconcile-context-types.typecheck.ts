import type {
  AskResult,
  ReconcileContext,
} from "@compforge/baton-plugin";

type Equal<TLeft, TRight> =
  (<T>() => T extends TLeft ? 1 : 2) extends
    (<T>() => T extends TRight ? 1 : 2) ? true : false;
type Expect<TValue extends true> = TValue;

declare const context: ReconcileContext;

const closedChoice = context.ask({
  timeoutMs: 1_000,
  title: "Execution",
  prompt: "How should this run?",
  choices: [
    { value: "run", label: "Run" },
    { value: "edit", label: "Edit" },
  ],
});
type ClosedChoiceResult = Expect<
  Equal<Awaited<typeof closedChoice>, AskResult<"run" | "edit">>
>;

const choiceOrText = context.ask({
  timeoutMs: 1_000,
  title: "Execution",
  prompt: "How should this run?",
  choices: [
    { value: "run", label: "Run" },
    { value: "edit", label: "Edit" },
  ],
  allowOther: true,
});
type ChoiceOrTextResult = Expect<
  Equal<Awaited<typeof choiceOrText>, AskResult<string>>
>;

const freeText = context.ask({
  timeoutMs: 1_000,
  title: "Reason",
  prompt: "Why?",
  allowOther: true,
});
type FreeTextResult = Expect<
  Equal<Awaited<typeof freeText>, AskResult<string>>
>;

// @ts-expect-error A question without choices must explicitly opt into free text.
context.ask({ timeoutMs: 1_000, title: "Reason", prompt: "Why?" });

void (0 as unknown as ClosedChoiceResult);
void (0 as unknown as ChoiceOrTextResult);
void (0 as unknown as FreeTextResult);
