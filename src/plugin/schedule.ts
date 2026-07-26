import { CronExpressionParser } from "cron-parser";

import type { ResourceSchedule } from "@qiankun01/baton-plugin";
import type { ReconcileScope } from "./controller.ts";
import {
  reconcileScopeId,
  sameReconcileScope,
} from "./reconcile-scope.ts";

interface ScheduledResourceScope {
  readonly scope: ReconcileScope;
  readonly schedule: ResourceSchedule;
  nextAtMs: number;
}

export interface ResourceScheduleQueueOptions {
  now?: () => Date;
  onDue(scope: ReconcileScope): void;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function timestamp(now: () => Date): number {
  const value = now();
  if (Number.isNaN(value.getTime())) {
    throw new Error("plugin schedule queue now() returned an invalid Date");
  }
  return value.getTime();
}

function scheduleEntryId(
  scope: ReconcileScope,
  scheduleId: string,
): string {
  return JSON.stringify([reconcileScopeId(scope), scheduleId]);
}

export function nextResourceScheduleAt(
  schedule: ResourceSchedule,
  currentDate: Date,
): Date {
  try {
    return CronExpressionParser.parse(schedule.cron, {
      currentDate,
      tz: schedule.timeZone,
    }).next().toDate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `invalid Resource schedule ${schedule.scheduleId}: ${detail}`,
    );
  }
}

export function validateResourceSchedules(
  schedules: readonly ResourceSchedule[] | undefined,
  currentDate: Date,
): void {
  if (!schedules) return;
  const ids = new Set<string>();
  for (const schedule of schedules) {
    if (!schedule.scheduleId.trim()) {
      throw new Error("Resource schedule scheduleId must not be empty");
    }
    if (ids.has(schedule.scheduleId)) {
      throw new Error(
        `Resource scheduleId already registered: ${schedule.scheduleId}`,
      );
    }
    ids.add(schedule.scheduleId);
    if (!schedule.cron.trim()) {
      throw new Error(
        `Resource schedule ${schedule.scheduleId} cron must not be empty`,
      );
    }
    if (!schedule.timeZone.trim()) {
      throw new Error(
        `Resource schedule ${schedule.scheduleId} timeZone must not be empty`,
      );
    }
    nextResourceScheduleAt(schedule, currentDate);
  }
}

/**
 * Process-local cron wakeups. A tick is a coalescible signal: it is reduced to
 * one Resource scope before Manager enumerates keys into the normal workqueue.
 */
export class ResourceScheduleQueue {
  private readonly entries = new Map<string, ScheduledResourceScope>();
  private readonly now: () => Date;
  private readonly onDue: ResourceScheduleQueueOptions["onDue"];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: ResourceScheduleQueueOptions) {
    this.now = options.now ?? (() => new Date());
    this.onDue = options.onDue;
  }

  register(
    scope: ReconcileScope,
    schedules: readonly ResourceSchedule[],
  ): void {
    const now = new Date(timestamp(this.now));
    validateResourceSchedules(schedules, now);
    for (const schedule of schedules) {
      const id = scheduleEntryId(scope, schedule.scheduleId);
      if (this.entries.has(id)) {
        throw new Error(
          `Resource schedule already active: ${schedule.scheduleId}`,
        );
      }
      this.entries.set(id, {
        scope,
        schedule,
        nextAtMs: nextResourceScheduleAt(schedule, now).getTime(),
      });
    }
    this.arm();
  }

  removeScope(scope: ReconcileScope): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (!sameReconcileScope(entry.scope, scope)) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.arm();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      earliest = Math.min(earliest, entry.nextAtMs);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, earliest - timestamp(this.now)),
    );
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    const nowMs = timestamp(this.now);
    const dueScopes = new Map<string, ReconcileScope>();
    for (const entry of this.entries.values()) {
      if (entry.nextAtMs > nowMs) continue;
      entry.nextAtMs = nextResourceScheduleAt(
        entry.schedule,
        new Date(nowMs),
      ).getTime();
      dueScopes.set(reconcileScopeId(entry.scope), entry.scope);
    }
    this.arm();
    for (const scope of dueScopes.values()) this.onDue(scope);
  }
}
