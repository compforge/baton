import type { InteractionDraft, InteractionResult } from "./types.ts";

/** A reply becomes an effective InputResponse only after its request-specific contract passes. */
export function validInputResult(request: InteractionDraft, result: InteractionResult): boolean {
  if (result.kind === "cancelled") return true;
  switch (request.kind) {
    case "permission":
      return result.kind === "permission" && result.outcome === "selected" &&
        request.options.some((option) => option.optionId === result.optionId);
    case "question": {
      if (result.kind !== "question" || result.outcome !== "answered") return false;
      if (Object.keys(result.answers).some((id) => !request.questions.some((q) => q.questionId === id))) return false;
      return request.questions.every((question) => {
        const values = result.answers[question.questionId];
        if (!values?.length || (!question.multiSelect && values.length !== 1)) return false;
        if (new Set(values).size !== values.length || values.some((value) => !value.trim())) return false;
        return !question.choices?.length || question.allowOther === true ||
          values.every((value) => question.choices!.some((choice) => choice.value === value));
      });
    }
    case "suggested_input":
      return result.kind === "suggested_input" &&
        (result.outcome === "dismissed" || result.outcome === "submitted" && result.blocks.length > 0);
    case "harness_invocation":
      return result.kind === "harness_invocation" && (result.outcome === "approved" || result.outcome === "declined");
    case "hook_trust":
      return result.kind === "hook_trust" && (result.outcome === "trusted" || result.outcome === "skipped");
  }
}
