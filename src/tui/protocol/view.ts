import type {
  ChatViewState,
  InteractionView,
  PickerSearchView,
  RunStatusItem,
  TranscriptItem,
} from "chat-tui";

import type { BatonConfig } from "../../config/config.ts";
import type { Controller } from "../../controller/index.ts";
import { textOf } from "../../event/types.ts";
import {
  harnessDefinitionFor,
  harnessShortName,
} from "../../harness/registry.ts";
import type {
  HookTrustInteraction,
  Interaction,
  PermissionOption,
} from "../../interaction/types.ts";
import type { BoardItem } from "../../plugin/board.ts";
import type { Manager } from "../../plugin/manager.ts";
import type { ToastMessage } from "../../plugin/package.ts";
import type { SessionState } from "../../store/reduce.ts";
import type { SessionHandle } from "../../store/store.ts";
import {
  buildTranscript,
  normalizePlanStatus,
  userVisibleText,
} from "./transcript.ts";

export type BoardMode = "auto" | "open" | "hidden";

export interface BoardViewProjection {
  readonly items: readonly BoardItem[];
  readonly mode: BoardMode;
  readonly sidecar: ChatViewState["sidecar"];
}

export interface PickerViewProjection {
  id: string;
  title: string;
  options: Array<{ name: string; description: string; value: string }>;
  search?: PickerSearchView;
}

export interface ChatViewProjectionInput {
  state: SessionState;
  controller: Controller;
  pendingProposals: ReturnType<Manager["listPendingProposals"]>;
  session: SessionHandle;
  config: Pick<BatonConfig, "showThoughts">;
  harnessTargetId: string;
  toast: ToastMessage | null;
  commandOutput: TranscriptItem | null;
  picker: PickerViewProjection | null;
  board: BoardViewProjection;
}

function approvalOptionKind(option: PermissionOption): string {
  const lasting = option.lifetime !== "once";
  return option.polarity === "allow"
    ? lasting
      ? "allow_always"
      : "allow_once"
    : lasting
      ? "reject_always"
      : "reject_once";
}

function hookTrustDescription(interaction: HookTrustInteraction): string {
  return interaction.hooks
    .map((hook) => {
      const owner = hook.pluginId ?? hook.source;
      const matcher = hook.matcher ? ` · matcher: ${hook.matcher}` : "";
      return `${owner} · ${hook.trustStatus}${matcher}\n${hook.sourcePath}\n${hook.command}`;
    })
    .join("\n\n");
}

function harnessAuthor(harness: string | undefined): string | undefined {
  if (!harness) return undefined;
  return harnessShortName(harness);
}

function interactionRequester(interaction: Interaction): string {
  if (interaction.requester.type === "harness") {
    return (
      harnessAuthor(interaction.requester.harnessTargetId) ??
      interaction.requester.harnessTargetId
    );
  }
  if (interaction.requester.type === "plugin") {
    return interaction.requester.pluginInstanceId;
  }
  return "baton";
}

function interactionView(interaction: Interaction): InteractionView {
  const requester = interactionRequester(interaction);
  if (interaction.kind === "permission") {
    return {
      id: interaction.interactionId,
      kind: "approval",
      blocking: true,
      requester,
      approval: {
        title: interaction.title,
        description: interaction.description,
        options: interaction.options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: approvalOptionKind(option),
        })),
      },
    };
  }
  if (interaction.kind === "question") {
    return {
      id: interaction.interactionId,
      kind: "question",
      blocking: true,
      requester,
      question: {
        questions: interaction.questions.map((prompt) => ({
          id: prompt.questionId,
          header: prompt.header,
          question: prompt.question,
          options: prompt.options?.map((option) => ({
            label: option.label,
            description: option.description,
            ...(option.preview === undefined ? {} : { preview: option.preview }),
          })),
          multiSelect: prompt.multiSelect,
          allowOther: prompt.allowOther,
          secret: prompt.secret,
        })),
      },
    };
  }
  return {
    id: interaction.interactionId,
    kind: "approval",
    blocking: true,
    requester,
    approval: {
      title: `Trust ${interaction.hooks.length} ${interaction.harnessName} hook${interaction.hooks.length === 1 ? "" : "s"}?`,
      description: hookTrustDescription(interaction),
      options: [
        {
          optionId: "trust",
          name: "Trust current definitions (ask again if changed)",
          kind: "allow_always",
        },
        {
          optionId: "skip",
          name: "Continue without Codex hooks",
          kind: "reject_once",
        },
      ],
    },
  };
}

/**
 * Run status 文案合成：显式阶段 / retry / 进行中工具依次覆盖默认 thinking。
 * phase 按 turn 取，避免并发 turn 的短寿命状态相互污染。
 */
export function runStatusLabel(
  state: Pick<
    SessionState,
    "activeTurns" | "toolCalls" | "lastError" | "lastSeq"
  >,
  turnId?: string,
): string {
  const phase =
    turnId !== undefined
      ? state.activeTurns.get(turnId)?.phase
      : [...state.activeTurns.values()].find((turn) => turn.phase)?.phase;
  if (phase) return phase.title ?? `${phase.phase}…`;
  if (state.lastError?.willRetry && state.lastError.seq === state.lastSeq) {
    return "retrying…";
  }
  const tool = [...state.toolCalls.values()]
    .reverse()
    .find(
      (candidate) =>
        (candidate.status === "pending" ||
          candidate.status === "in_progress") &&
        (turnId === undefined || candidate.turnId === turnId),
    );
  if (tool) {
    const labels: Record<string, string> = {
      read: "reading…",
      edit: "editing…",
      delete: "deleting…",
      move: "moving…",
      search: "searching…",
      execute: "running command…",
      think: "thinking…",
      fetch: "fetching…",
    };
    return (
      labels[tool.kind ?? ""] ??
      `${tool.title?.split(":", 1)[0]?.trim() || "using tool"}…`
    );
  }
  return "thinking…";
}

export function contextUsageText(
  context:
    | { model?: string; contextUsed?: number; contextSize?: number }
    | undefined,
  selectedModel: string,
): string {
  if (!context || (context.model && context.model !== selectedModel)) {
    return "unavailable until the harness reports this model";
  }
  if (!context.contextSize || context.contextSize < 0) return "size unavailable";
  const size = context.contextSize.toLocaleString("en-US");
  if (context.contextUsed === undefined) return `${size} tokens`;
  const percent = Math.round((context.contextUsed / context.contextSize) * 100);
  return `${context.contextUsed.toLocaleString("en-US")} / ${size} tokens (${percent}%)`;
}

function contextUsageStatusText(
  context:
    | { model?: string; contextUsed?: number; contextSize?: number }
    | undefined,
  selectedModel: string,
): string | undefined {
  if (
    !context ||
    (context.model && context.model !== selectedModel) ||
    context.contextUsed === undefined ||
    !context.contextSize ||
    context.contextSize < 0
  ) {
    return undefined;
  }
  const percent = Math.round((context.contextUsed / context.contextSize) * 100);
  return `context ${context.contextUsed.toLocaleString("en-US")}/${context.contextSize.toLocaleString("en-US")} (${percent}%)`;
}

export function projectBoardView(
  items: readonly BoardItem[],
  mode: BoardMode,
): BoardViewProjection {
  const sections = new Map<
    string,
    {
      id: string;
      title: string;
      items: Array<{
        id: string;
        title: string;
        status?: string;
        detail?: string;
        tone?: "default" | "muted" | "success" | "warning" | "error";
      }>;
    }
  >();
  for (const item of items) {
    let section = sections.get(item.pluginInstanceId);
    if (!section) {
      section = {
        id: item.pluginInstanceId,
        title: item.pluginId,
        items: [],
      };
      sections.set(item.pluginInstanceId, section);
    }
    section.items.push({
      id: item.id,
      title: item.title,
      ...(item.status === undefined ? {} : { status: item.status }),
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(item.tone === undefined ? {} : { tone: item.tone }),
    });
  }
  return {
    items,
    mode,
    sidecar:
      items.length > 0
        ? {
            title: "Board",
            mode,
            sections: [...sections.values()],
          }
        : undefined,
  };
}

/** Baton 领域状态 → chat-tui 完整兼容快照。 */
export function projectChatView(input: ChatViewProjectionInput): ChatViewState {
  const {
    state,
    controller,
    session,
    harnessTargetId,
    pendingProposals,
    board,
  } = input;
  const activeTargetId = controller.activeHarnessTargetId;
  const interactions: InteractionView[] = [
    ...[...state.interactions.values()]
      .filter((item) => !item.resolution)
      .map((item) => interactionView(item.interaction)),
    ...pendingProposals.map((proposal) => ({
      id: proposal.proposalId,
      kind: "suggested_input" as const,
      blocking: false,
      requester: proposal.key.pluginInstanceId,
      title: "Suggested follow-up",
      text: proposal.text,
    })),
  ];
  const observedRuns = [...state.activeTurns.values()].filter(
    (turn) => turn.role === "observed",
  );
  const observedRun = observedRuns.at(-1);
  const activeTurnId = controller.activeTurnId;
  const activeTurn = activeTurnId
    ? state.activeTurns.get(activeTurnId)
    : undefined;
  const statusTargetId =
    activeTargetId ?? observedRun?.harnessTargetId ?? harnessTargetId;
  const targetState = state.perTarget.get(statusTargetId);
  const statusHarness =
    activeTurn?.harness ??
    observedRun?.harness ??
    targetState?.harness ??
    harnessDefinitionFor(statusTargetId)?.sessionKey ??
    statusTargetId;
  const statusModel =
    statusTargetId === activeTargetId || statusTargetId === harnessTargetId
      ? (controller.currentModel(statusTargetId) ?? "default")
      : (targetState?.contextUsage?.model ?? "default");
  const statusEffort =
    statusTargetId === activeTargetId || statusTargetId === harnessTargetId
      ? controller.currentEffort(statusTargetId)
      : session.meta.harnessSessions[statusTargetId]?.effort;
  const modelAndEffort = statusEffort
    ? `${statusModel} · ${statusEffort}`
    : statusModel;
  const contextStatus = contextUsageStatusText(
    targetState?.contextUsage,
    statusModel,
  );
  const approvalStatus =
    controller.approvalRoute(statusTargetId) === "delegated"
      ? "approvals:auto-review"
      : undefined;
  const statusDetails = [contextStatus, approvalStatus].filter(
    (detail): detail is string => detail !== undefined,
  );
  const splitStatus = (item: RunStatusItem): RunStatusItem[] => {
    if (statusDetails.length === 0) return [item];
    const { startedAt, hint, ...primary } = item;
    return [
      primary,
      {
        id: `${item.id}:details`,
        label: statusDetails.join(" · "),
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(hint ? { hint } : {}),
      },
    ];
  };
  const runStatus: RunStatusItem[] = activeTargetId
    ? splitStatus({
        id: `run:${activeTargetId}`,
        author: harnessAuthor(statusHarness),
        label: `${modelAndEffort} · ${runStatusLabel(state, activeTurnId)}`,
        startedAt: controller.activeStartedAt,
        hint: "Esc to interrupt",
      })
    : observedRun
      ? splitStatus({
          id: `run:observed:${observedRun.turnId}`,
          author: harnessAuthor(statusHarness),
          label: `${modelAndEffort} · ${runStatusLabel(state, observedRun.turnId)} · background`,
          startedAt: observedRun.startedAt,
        })
      : splitStatus({
          id: `agent:${harnessTargetId}`,
          author: harnessAuthor(
            state.perTarget.get(harnessTargetId)?.harness ??
              harnessDefinitionFor(harnessTargetId)?.sessionKey ??
              harnessTargetId,
          ),
          label: `${modelAndEffort} · idle`,
        });
  const busy = activeTargetId !== undefined || observedRuns.length > 0;

  const lastPlanId = state.perTarget.get(harnessTargetId)?.lastPlanId;
  const lastPlan = lastPlanId ? state.plans.get(lastPlanId) : undefined;
  const planEntries = (lastPlan?.entries ?? []).map((entry) => ({
    content: entry.content,
    status: normalizePlanStatus(entry.status),
  }));
  const targetRunning = [...state.activeTurns.values()].some(
    (turn) => turn.harnessTargetId === harnessTargetId,
  );
  const planActive =
    targetRunning &&
    planEntries.some((entry) => entry.status !== "completed");
  const pinnedPlanId = planActive ? lastPlan?.planId : undefined;

  return {
    transcript: [
      ...buildTranscript(state, pinnedPlanId),
      ...(input.commandOutput ? [input.commandOutput] : []),
    ],
    busy,
    runStatus,
    plan: planActive ? planEntries : undefined,
    queued: controller.queuedTurns.map((turn) => ({
      id: String(turn.id),
      text: userVisibleText(textOf(turn.blocks)),
      tag: turn.harnessTargetId,
    })),
    picker: input.picker
      ? {
          id: input.picker.id,
          title: input.picker.title,
          options: input.picker.options,
          ...(input.picker.search ? { search: input.picker.search } : {}),
        }
      : null,
    interactions,
    sidecar: board.sidecar,
    toast: input.toast,
    footer: `session: ${session.id}  in:${state.usage.inputTokens} out:${state.usage.outputTokens}  turns:${state.turnSummaries.length}  queue:${controller.queueLength}${planActive ? `  plan:${planEntries.filter((entry) => entry.status === "completed").length}/${planEntries.length}` : ""}${board.items.length > 0 ? `  board:${board.items.length}` : ""}  cwd:${session.meta.cwd}`,
    composerPlaceholder: `Message ${harnessTargetId} (/ commands, @ mentions, ${
      controller.queueLength > 0
        ? "↑ recall queued"
        : controller.isBusy
          ? "Enter sends or queues"
          : "Ctrl+J newline"
    })`,
    header: `baton · session ${session.id}\ntype to chat · /codex or /claude switch · /sessions open · @bs_xxx reference another session\n`,
    showThoughts: input.config.showThoughts,
  };
}
