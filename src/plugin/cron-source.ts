import { CronExpressionParser } from "cron-parser";

import type {
  ControllerSource,
  CronSource,
} from "@qiankun01/baton-plugin";
import type { ReconcileScope } from "./controller.ts";
import {
  reconcileScopeId,
  sameReconcileScope,
} from "./reconcile-scope.ts";

interface ScheduledControllerScope {
  readonly scope: ReconcileScope;
  readonly source: CronSource;
  nextAtMs: number;
}

export interface CronSourceQueueOptions {
  now?: () => Date;
  onDue(
    scope: ReconcileScope,
    sources: readonly CronSource[],
  ): void;
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
  sourceId: string,
): string {
  return JSON.stringify([reconcileScopeId(scope), sourceId]);
}

export function nextCronSourceAt(
  source: CronSource,
  currentDate: Date,
): Date {
  try {
    return CronExpressionParser.parse(source.cron, {
      currentDate,
      tz: source.timeZone,
    }).next().toDate();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `invalid Controller cron source ${source.sourceId}: ${detail}`,
    );
  }
}

export function validateControllerSources(
  sources: readonly ControllerSource[] | undefined,
  currentDate: Date,
): void {
  if (!sources) return;
  const ids = new Set<string>();
  for (const source of sources) {
    if (source.type !== "cron") {
      throw new Error(`unsupported Controller source type: ${String(source.type)}`);
    }
    if (!source.sourceId.trim()) {
      throw new Error("Controller cron sourceId must not be empty");
    }
    if (ids.has(source.sourceId)) {
      throw new Error(
        `Controller sourceId already registered: ${source.sourceId}`,
      );
    }
    ids.add(source.sourceId);
    if (!source.cron.trim()) {
      throw new Error(
        `Controller cron source ${source.sourceId} cron must not be empty`,
      );
    }
    if (!source.timeZone.trim()) {
      throw new Error(
        `Controller cron source ${source.sourceId} timeZone must not be empty`,
      );
    }
    nextCronSourceAt(source, currentDate);
  }
}

/**
 * Process-local cron Sources. A tick is a coalescible signal: it is reduced to
 * one Controller scope before Manager enumerates Resource keys into its queue.
 */
export class CronSourceQueue {
  private readonly entries = new Map<string, ScheduledControllerScope>();
  private readonly now: () => Date;
  private readonly onDue: CronSourceQueueOptions["onDue"];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: CronSourceQueueOptions) {
    this.now = options.now ?? (() => new Date());
    this.onDue = options.onDue;
  }

  register(
    scope: ReconcileScope,
    sources: readonly ControllerSource[],
  ): void {
    const now = new Date(timestamp(this.now));
    validateControllerSources(sources, now);
    for (const source of sources) {
      const id = scheduleEntryId(scope, source.sourceId);
      if (this.entries.has(id)) {
        throw new Error(
          `Controller source already active: ${source.sourceId}`,
        );
      }
      this.entries.set(id, {
        scope,
        source,
        nextAtMs: nextCronSourceAt(source, now).getTime(),
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
    const dueScopes = new Map<string, {
      scope: ReconcileScope;
      sources: CronSource[];
    }>();
    for (const entry of this.entries.values()) {
      if (entry.nextAtMs > nowMs) continue;
      entry.nextAtMs = nextCronSourceAt(
        entry.source,
        new Date(nowMs),
      ).getTime();
      const scopeId = reconcileScopeId(entry.scope);
      const due = dueScopes.get(scopeId);
      if (due) {
        due.sources.push(entry.source);
      } else {
        dueScopes.set(scopeId, {
          scope: entry.scope,
          sources: [entry.source],
        });
      }
    }
    this.arm();
    for (const due of dueScopes.values()) {
      this.onDue(due.scope, Object.freeze(due.sources));
    }
  }
}
