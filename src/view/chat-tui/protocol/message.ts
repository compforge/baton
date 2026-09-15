import { textOf } from "../../../event/index.ts";
import type { InteractionDraft } from "../../../interaction/types.ts";
import type { InputResponse, Message } from "../../../message/types.ts";
import { getMessage } from "../../../message/query.ts";
import type { SessionState } from "../../../store/reduce.ts";

function requestText(request: InteractionDraft): string {
  switch (request.kind) {
    case "question": return request.questions.map((question) => question.question).join("\n");
    case "permission": return [request.title, request.description].filter(Boolean).join("\n");
    case "suggested_input": return request.title;
    case "harness_invocation": return request.title;
    case "hook_trust": return `Trust ${request.hooks.length} ${request.harnessName} hooks?`;
  }
}

function responseText(message: InputResponse, state: SessionState): string {
  const parent = getMessage(state, message.replyToMessageIds[0]);
  const request = parent?.kind === "input_request" ? parent.request : undefined;
  const answer = message.answer;
  switch (answer.kind) {
    case "question":
      // A secret answer may be delivered to its requester, but must not become
      // plaintext transcript or a reply-reference preview. Unknown schema is hidden too.
      return Object.entries(answer.answers).map(([id, values]) => {
        const question = request?.kind === "question"
          ? request.questions.find((entry) => entry.questionId === id) : undefined;
        if (!question || question.secret) return "[hidden answer]";
        return values.map((value) => question.choices?.find((choice) => choice.value === value)?.label ?? value).join(", ");
      }).join("\n");
    case "permission":
      return request?.kind === "permission"
        ? request.options.find((option) => option.optionId === answer.optionId)?.name ?? answer.optionId
        : answer.optionId;
    case "suggested_input": return answer.outcome === "submitted" ? "Draft submitted" : "Draft dismissed";
    case "harness_invocation": return answer.outcome;
    case "hook_trust": return answer.outcome;
  }
}

/** Shared by history rendering and cross-message reply labels. */
export function messageText(message: Message, state: SessionState): string {
  switch (message.kind) {
    case "input":
    case "output": return textOf(message.content);
    case "input_request": return requestText(message.request);
    case "input_response": return responseText(message, state);
  }
}
