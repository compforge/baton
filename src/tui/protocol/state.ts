// Baton 领域状态到 chat-tui State 的投影。

import type {
  ChatState,
  InteractionResponse,
  InteractionView,
  PickerSearchView,
  RunStatusItem,
  TranscriptItem,
} from "chat-tui";

import type { BatonConfig } from "../../config/config.ts";
import type { Controller } from "../../controller/index.ts";
import { textOf, type ContextWindowUpdate } from "../../event/index.ts";
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
import type { ToastMessage } from "../../plugin/package.ts";
import {
  laneTargetStateKey,
  type SessionState,
} from "../../store/reduce.ts";
import { MAIN_LANE_ID } from "../../lane.ts";
import type { SessionHandle } from "../../store/store.ts";
import { composerTextOf } from "../prompt-images.ts";
import {
  buildTranscript,
  normalizePlanStatus,
  userVisibleText,
} from "./transcript.ts";

export type BoardMode = "auto" | "open" | "hidden";

export interface BoardViewProjection {
  readonly items: readonly BoardItem[];
  readonly mode: BoardMode;
  readonly sidecar: ChatState["sidecar"];
}

export interface PickerViewProjection {
  id: string;
  title: string;
  options: Array<{ name: string; description: string; value: string }>;
  search?: PickerSearchView;
}

export interface ChatStateProjectionInput {
  state: SessionState;
  controller: Controller;
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

function interactionView(
  interaction: Interaction,
): InteractionView {
  const requester = interactionRequester(interaction);
  if (interaction.kind === "permission") {
    return {
      id: interaction.interactionId,
      kind: "approval",
      blocking: true,
      requester,
      cancelResponse: { kind: "cancelled" },
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
    const onlyQuestion =
      interaction.questions.length === 1
        ? interaction.questions[0]
        : undefined;
    const rejectChoice = onlyQuestion?.choices?.find(
      (choice) => choice.role === "reject",
    );
    const cancelResponse: InteractionResponse =
      onlyQuestion && rejectChoice
        ? {
            kind: "question",
            answers: {
              [onlyQuestion.questionId]: [rejectChoice.label],
            },
          }
        : { kind: "cancelled" };
    return {
      id: interaction.interactionId,
      kind: "question",
      blocking: true,
      requester,
      cancelResponse,
      question: {
        questions: interaction.questions.map((prompt) => ({
          id: prompt.questionId,
          header: prompt.header,
          question: prompt.question,
          options: prompt.choices?.map((choice) => ({
            label: choice.label,
            description: choice.description ?? "",
            ...(choice.preview === undefined ? {} : { preview: choice.preview }),
          })),
          multiSelect: prompt.multiSelect,
          allowOther: prompt.allowOther,
          secret: prompt.secret,
        })),
      },
    };
  }
  if (interaction.kind === "suggested_input") {
    return {
      id: interaction.interactionId,
      kind: "suggested_input",
      blocking: false,
      requester,
      title: interaction.harnessTargetId === undefined
        ? interaction.title
        : `${interaction.title} · Target ${interaction.harnessTargetId}`,
      text: interaction.text,
      cancelResponse: {
        kind: "suggested_input",
        outcome: "dismissed",
      },
    };
  }
  if (interaction.kind === "harness_invocation") {
    return {
      id: interaction.interactionId,
      kind: "approval",
      blocking: true,
      requester,
      cancelResponse: { kind: "cancelled" },
      approval: {
        title: interaction.title,
        description: interaction.prompt,
        options: [
          {
            optionId: "approve",
            name: "Run",
            kind: "allow_once",
          },
          {
            optionId: "decline",
            name: "Cancel",
            kind: "reject_once",
          },
        ],
      },
    };
  }
  return {
    id: interaction.interactionId,
    kind: "approval",
    blocking: true,
    requester,
    cancelResponse: { kind: "approval", optionId: "skip" },
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

export function contextWindowText(
  context: ContextWindowUpdate | undefined,
  selectedModel: string,
): string {
  if (!context || context.modelSelection !== selectedModel) {
    return "unavailable until the harness reports this model";
  }
  if (!context.capacityTokens || context.capacityTokens < 0) return "size unavailable";
  const size = context.capacityTokens.toLocaleString("en-US");
  const percent = Math.round((context.usedTokens / context.capacityTokens) * 100);
  return `${context.usedTokens.toLocaleString("en-US")} / ${size} tokens (${percent}%)`;
}

function contextWindowStatusText(
  context: ContextWindowUpdate | undefined,
  selectedModel: string,
): string | undefined {
  if (
    !context ||
    context.modelSelection !== selectedModel ||
    !context.capacityTokens ||
    context.capacityTokens < 0
  ) {
    return undefined;
  }
  const percent = Math.round((context.usedTokens / context.capacityTokens) * 100);
  return `context ${percent}%`;
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
        url?: string;
        status?: string;
        detail?: string;
        tone?: "default" | "muted" | "success" | "warning" | "error";
      }>;
    }
  >();
  for (const item of items) {
    const sectionId = JSON.stringify([
      item.pluginInstanceId,
      item.resourceApiVersion,
      item.resourceKind,
    ]);
    let section = sections.get(sectionId);
    if (!section) {
      section = {
        id: sectionId,
        title: item.resourceShortName ?? item.resourceKind,
        items: [],
      };
      sections.set(sectionId, section);
    }
    section.items.push({
      id: item.id,
      title: item.title,
      ...(item.url === undefined ? {} : { url: item.url }),
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

/**
 * Baton 领域状态 → chat-tui State。
 *
 * @rule Order status segments by volatility: stable model and configuration precede active phase
 * or tool activity, while changing observations such as context usage stay at the end so frequent
 * updates disturb only the right side.
 */
export function projectChatState(input: ChatStateProjectionInput): ChatState {
  const {
    state,
    controller,
    session,
    harnessTargetId,
    board,
  } = input;
  const activeTargetId = controller.activeHarnessTargetId;
  const mainQueuedInputs = controller.queuedHarnessInputs.filter(
    (turn) => turn.laneId === MAIN_LANE_ID,
  );
  const hasRecallableQueuedInput = mainQueuedInputs.some(
    (turn) => turn.source.type === "user" && !turn.harnessInvocationId,
  );
  const interactions: InteractionView[] = [...state.interactions.values()]
    .filter((item) => !item.result)
    .map((item) => interactionView(item.interaction));
  const mainRuns = [...state.activeTurns.values()].filter(
    (turn) =>
      (!turn.laneId || turn.laneId === MAIN_LANE_ID),
  );
  const sideRuns = [...state.activeTurns.values()].filter(
    (turn) =>
      turn.laneId !== undefined && turn.laneId !== MAIN_LANE_ID,
  );
  const mainRun = mainRuns.at(-1);
  const activeTurnId = controller.activeTurnId;
  const activeTurn = activeTurnId
    ? state.activeTurns.get(activeTurnId)
    : undefined;
  const statusTargetId =
    activeTargetId ?? mainRun?.harnessTargetId ?? harnessTargetId;
  const statusLaneId = MAIN_LANE_ID;
  const laneTargetState = state.perLaneTarget.get(
    laneTargetStateKey(statusLaneId, statusTargetId),
  );
  const targetState =
    laneTargetState ??
    state.perTarget.get(statusTargetId);
  const statusHarness =
    activeTurn?.harness ??
    mainRun?.harness ??
    targetState?.harness ??
    harnessDefinitionFor(statusTargetId)?.sessionKey ??
    statusTargetId;
  const statusModel =
    statusTargetId === activeTargetId || statusTargetId === harnessTargetId
      ? (controller.currentModel(statusTargetId) ?? "default")
      : (laneTargetState?.contextWindow?.modelSelection ?? "default");
  const statusEffort =
    statusTargetId === activeTargetId || statusTargetId === harnessTargetId
      ? controller.currentEffort(statusTargetId)
      : session.meta.harnessTargets[statusTargetId]?.effort;
  const statusMode = controller.currentMode(statusTargetId);
  const modelAndEffort = statusEffort
    ? `${statusModel} · ${statusEffort}`
    : statusModel;
  const fastStatus = targetState?.configOptions?.some(
    (option) => option.id === "fast" && option.type === "boolean" && option.value,
  )
    ? "Fast"
    : undefined;
  const modeStatus = statusMode === "default" ? undefined : `${statusMode} mode`;
  const approvalStatus =
    controller.approvalRoute(statusTargetId) === "delegated"
      ? "approvals:auto-review"
      : undefined;
  const harnessConfigStatus = [
    modelAndEffort,
    fastStatus,
    modeStatus,
    approvalStatus,
  ].filter((detail): detail is string => detail !== undefined).join(" · ");
  const contextStatus = contextWindowStatusText(
    laneTargetState?.contextWindow,
    statusModel,
  );
  const statusDetails = [contextStatus].filter(
    (detail): detail is string => detail !== undefined,
  );
  const withStatusDetails = (item: RunStatusItem): RunStatusItem => ({
    ...item,
    label: [item.label, ...statusDetails].join(" · "),
  });
  const runStatusItem: RunStatusItem = activeTargetId
    ? {
        id: `run:${activeTargetId}`,
        author: harnessAuthor(statusHarness),
        label: `${harnessConfigStatus} · ${runStatusLabel(state, activeTurnId)}`,
        startedAt: controller.activeStartedAt,
      }
    : mainRun
      ? {
          id: `run:${mainRun.turnId}`,
          author: harnessAuthor(statusHarness),
          label: `${harnessConfigStatus} · ${runStatusLabel(state, mainRun.turnId)}`,
          startedAt: mainRun.startedAt,
        }
      : {
          id: `agent:${harnessTargetId}`,
          author: harnessAuthor(
            state.perTarget.get(harnessTargetId)?.harness ??
              harnessDefinitionFor(harnessTargetId)?.sessionKey ??
              harnessTargetId,
          ),
          label: `${harnessConfigStatus} · idle`,
        };
  const sideStartedAt = sideRuns
    .flatMap((turn) => (turn.startedAt === undefined ? [] : [turn.startedAt]))
    .sort((left, right) => left - right)[0];
  const runStatus = [
    withStatusDetails(runStatusItem),
    ...(sideRuns.length > 0
      ? [
          {
            id: "run:side-lanes",
            author: "baton",
            label: `${sideRuns.length} side lane${sideRuns.length === 1 ? "" : "s"}`,
            ...(sideStartedAt === undefined
              ? {}
              : { startedAt: sideStartedAt }),
          } satisfies RunStatusItem,
        ]
      : []),
  ];
  const busy = activeTargetId !== undefined || mainRuns.length > 0;

  const selectedLaneId = MAIN_LANE_ID;
  const selectedState =
    state.perLaneTarget.get(laneTargetStateKey(selectedLaneId, harnessTargetId)) ??
    state.perTarget.get(harnessTargetId);
  const lastPlanId = selectedState?.lastPlanId;
  const lastPlan = lastPlanId ? state.plans.get(lastPlanId) : undefined;
  const planEntries = (lastPlan?.entries ?? []).map((entry) => ({
    content: entry.content,
    status: normalizePlanStatus(entry.status),
  }));
  const targetRunning = [...state.activeTurns.values()].some(
    (turn) =>
      turn.harnessTargetId === harnessTargetId &&
      (!turn.laneId || turn.laneId === selectedLaneId),
  );
  const planActive =
    targetRunning &&
    planEntries.some((entry) => entry.status !== "completed");
  const pinnedPlanId = planActive ? lastPlan?.planId : undefined;
  const pendingSteers = [...state.messages.values()].filter(
    (message) =>
      message.role === "user" &&
      message.delivery === "steer" &&
      message.deliveryState === "pending" &&
      message.laneId === MAIN_LANE_ID,
  );
  const queuedItems = [
    ...pendingSteers.map((message) => ({
      id: message.messageId,
      text: userVisibleText(composerTextOf(message.content)),
      tag: `${message.harnessTargetId ?? message.harness ?? harnessTargetId} · ${
        message.turnId !== undefined && state.activeTurns.has(message.turnId)
          ? "current turn"
          : "native queue"
      }`,
    })),
    ...mainQueuedInputs.map((turn) => ({
      id: turn.messageId,
      text: userVisibleText(composerTextOf(turn.blocks)),
      tag:
        turn.source.type === "plugin"
          ? `${turn.source.pluginInstanceId} · request`
          : `${turn.harnessTargetId} · next turn`,
    })),
  ];

  return {
    timeline: {
      items: [
        ...buildTranscript(state, pinnedPlanId, {
          isSideLane: (laneId) => laneId !== MAIN_LANE_ID,
        }),
        ...(input.commandOutput ? [input.commandOutput] : []),
      ],
      plan: planActive ? planEntries : undefined,
      header: `baton · session ${session.id}\ntype to chat · /target switches HarnessTarget · /sessions open · @bs_xxx reference another session\n`,
      showThoughts: input.config.showThoughts,
    },
    composer: {
      busy,
      queued: queuedItems,
      picker: input.picker
        ? {
            id: input.picker.id,
            title: input.picker.title,
            options: input.picker.options,
            ...(input.picker.search ? { search: input.picker.search } : {}),
          }
        : null,
      interactions,
      placeholder: `Message ${harnessTargetId} (/ commands, @ mentions, Shift+Tab mode, ${
        hasRecallableQueuedInput
          ? "↑ recall queued"
          : controller.isBusy
            ? "Enter sends or queues, Esc to interrupt"
            : "Ctrl+J newline"
      })`,
    },
    activity: {
      items: runStatus,
    },
    footer: {
      toast: input.toast,
      text: `session: ${session.id}  in:${state.usage.inputTokens} out:${state.usage.outputTokens}  turns:${state.turnSummaries.length}  queue:${queuedItems.length}${planActive ? `  plan:${planEntries.filter((entry) => entry.status === "completed").length}/${planEntries.length}` : ""}${board.items.length > 0 ? `  board:${board.items.length}` : ""}  cwd:${session.meta.cwd}`,
    },
    sidecar: board.sidecar,
  };
}
