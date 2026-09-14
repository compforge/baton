import type { ParallelItem } from "chat-tui";

import { harnessShortName } from "../../../harness/registry.ts";
import { MAIN_LANE_ID } from "../../../lane.ts";
import type { SessionState } from "../../../store/reduce.ts";

export type ParallelItemKind = "task" | "lane" | "invocation";
export type ParallelTab = "all" | "tasks" | "runs";
export type ParallelAction = "stop";

/** Baton-owned UI projection; runtime facts and lifecycle remain with Core/Harness owners. */
export interface BatonParallelItem extends ParallelItem {
  readonly kind: ParallelItemKind;
  /** Native/domain identity shown in details; item.id is the stable UI action key. */
  readonly sourceId: string;
  readonly actions: readonly ParallelAction[];
}

const LIVE_ASYNC_PHASES = new Set(["queued", "running", "uncertain"]);

/**
 * Project every live parallel runtime fact into one Baton UI item union.
 * ParallelItem is a View projection only. Actions re-resolve item.id through the Core owner;
 * neither the item nor the Parallel screen owns task or run lifecycle.
 */
export function projectParallelItems(
  state: SessionState,
  canStopTask: (taskKey: string) => boolean = () => false,
): BatonParallelItem[] {
  const items: BatonParallelItem[] = [];
  const representedLanes = new Set<string>();

  for (const invocation of state.harnessInvocations.values()) {
    if (!invocation.newLane || !LIVE_ASYNC_PHASES.has(invocation.phase)) continue;
    const turn = invocation.laneId
      ? [...state.activeTurns.values()].find(
          (candidate) => candidate.laneId === invocation.laneId,
        )
      : undefined;
    if (invocation.laneId) representedLanes.add(invocation.laneId);
    const author = harnessShortName(
      turn?.harness ?? invocation.harnessTargetId ?? "",
    );
    items.push({
      id: `invocation:${invocation.invocationId}`,
      kind: "invocation",
      sourceId: invocation.invocationId,
      actions: [],
      icon: "↗",
      name: author || invocation.harnessTargetId || "Harness",
      description: invocation.title,
      progress: invocation.pluginInstanceId
        ? `${invocation.phase} · requested by ${invocation.pluginInstanceId}`
        : invocation.phase,
      ...(turn?.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    });
  }

  const unrepresentedSideRuns = [...state.activeTurns.values()].filter(
    (turn) =>
      turn.laneId !== undefined &&
      turn.laneId !== MAIN_LANE_ID &&
      !representedLanes.has(turn.laneId),
  );
  for (const turn of unrepresentedSideRuns) {
    const laneId = turn.laneId!;
    representedLanes.add(laneId);
    items.push({
      id: `lane:${laneId}`,
      kind: "lane",
      sourceId: laneId,
      actions: [],
      icon: "↗",
      name: harnessShortName(turn.harness ?? "") || "Harness",
      description: `Lane ${laneId}`,
      progress: turn.state === "requires_action" ? "waiting" : "running",
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    });
  }

  for (const task of state.tasks.values()) {
    if (task.status !== "in_progress" || task.backgrounded === false) continue;
    const harness = harnessShortName(task.harness ?? "");
    const author = [harness, task.taskType].filter(Boolean).join("/");
    const description = task.title ?? task.summary;
    const detail = [
      task.spawnDepth !== undefined && task.spawnDepth > 1
        ? `depth ${task.spawnDepth}`
        : undefined,
      task.lastToolName,
      task.summary === description ? undefined : task.summary,
    ].filter((value): value is string => Boolean(value)).join(" · ");
    items.push({
      id: task.taskKey,
      kind: "task",
      sourceId: task.taskId,
      actions: canStopTask(task.taskKey) ? ["stop"] : [],
      icon: task.taskType ? "◇" : "•",
      name: author || "Task",
      description,
      progress: detail ? `running · ${detail}` : "running",
      ...(task.usage?.totalTokens === undefined
        ? {}
        : { tokens: task.usage.totalTokens }),
      ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    });
  }

  return items;
}

export function parallelTabItems(
  tab: ParallelTab,
  items: readonly BatonParallelItem[],
  query = "",
): BatonParallelItem[] {
  const inTab = tab === "all"
    ? items
    : tab === "tasks"
      ? items.filter((item) => item.kind === "task")
      : items.filter((item) => item.kind === "lane" || item.kind === "invocation");
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...inTab];
  return inTab.filter((item) =>
    [item.name, item.description, item.progress, item.sourceId]
      .filter(Boolean)
      .join("\n")
      .toLowerCase()
      .includes(normalized),
  );
}

/** Retain transcript context while keeping the manager usable on small terminals. */
export function parallelPanelHeight(terminalHeight: number): number {
  const available = Math.max(1, terminalHeight - 2);
  return Math.min(Math.max(12, Math.floor(terminalHeight * 0.45)), available);
}
