import type {
  ControllerSource,
  CronSource,
  ResourceType,
  Source,
  SourceContext,
} from "@compforge/baton-plugin";

import { nextCronSourceAt } from "./cron-source.ts";
import {
  PluginResourceStore,
  type PluginResource,
} from "./resource.ts";

export function validateSources<TSpec>(
  sources: readonly ControllerSource<TSpec>[] | undefined,
  currentDate: Date,
): void {
  if (!sources) return;
  const ids = new Set<string>();
  for (const source of sources) {
    if (!source.sourceId.trim()) {
      throw new Error("Controller sourceId must not be empty");
    }
    if (ids.has(source.sourceId)) {
      throw new Error(
        `Controller sourceId already registered: ${source.sourceId}`,
      );
    }
    ids.add(source.sourceId);
    if (source.type === "resource") {
      if (typeof source.start !== "function") {
        throw new Error(
          `Controller resource Source ${source.sourceId} must provide start()`,
        );
      }
      continue;
    }
    if (!source.cron.trim()) {
      throw new Error(
        `Controller cron Source ${source.sourceId} cron must not be empty`,
      );
    }
    if (!source.timeZone.trim()) {
      throw new Error(
        `Controller cron Source ${source.sourceId} timeZone must not be empty`,
      );
    }
    nextCronSourceAt(source, currentDate);
  }
}

interface ControllerSourcesOptions<TSpec, TStatus> {
  readonly sources?: readonly ControllerSource<TSpec>[];
  readonly store: PluginResourceStore;
  readonly resourceType: ResourceType;
  readonly executeWithCapacity: <T>(
    execute: () => Promise<T>,
  ) => Promise<T>;
  readonly onResource?: (
    resource: Readonly<PluginResource<TSpec, TStatus>>,
  ) => void;
  enqueue(resourceId: string): void;
}

/**
 * Owns one Controller's Source lifecycle. Initial discovery completes before
 * the Controller enumerates its Resources; later observations enqueue directly.
 */
export class ControllerSources<TSpec, TStatus> {
  readonly all: readonly ControllerSource<TSpec>[];
  private readonly options: ControllerSourcesOptions<TSpec, TStatus>;
  private abort?: AbortController;
  private starting?: Promise<void>;
  private ready = false;
  private closed = false;

  constructor(options: ControllerSourcesOptions<TSpec, TStatus>) {
    this.options = options;
    this.all = Object.freeze([...(options.sources ?? [])]);
  }

  cron(): readonly CronSource[] {
    return this.all.filter(
      (source): source is CronSource => source.type === "cron",
    );
  }

  async start(
    onError: (sourceId: string, error: unknown) => void,
  ): Promise<void> {
    if (!this.starting) {
      this.starting = this.startOnce(onError);
    }
    await this.starting;
  }

  close(): void {
    this.closed = true;
    this.abort?.abort();
  }

  private async startOnce(
    onError: (sourceId: string, error: unknown) => void,
  ): Promise<void> {
    const sources = this.all.filter(
      (source): source is Source<TSpec> =>
        source.type === "resource",
    );
    if (sources.length === 0) {
      this.ready = true;
      return;
    }

    const abort = new AbortController();
    this.abort = abort;
    await Promise.all(
      sources.map(async (source) => {
        const reportError = (error: unknown): void => {
          if (this.closed || abort.signal.aborted) return;
          try {
            onError(source.sourceId, error);
          } catch {
            // Source diagnostics must not interrupt discovery or live delivery.
          }
        };
        const emit: SourceContext<TSpec>["emit"] = async (input): Promise<void> => {
          if (this.closed || abort.signal.aborted) return;
          try {
            const { resource, created } =
              this.options.store.ensure<TSpec, TStatus>({
                type: this.options.resourceType,
                ...input,
              });
            if (created) {
              try {
                this.options.onResource?.(resource);
              } catch {
                // Resource is durable; projection invalidation is best-effort.
              }
            }
            if (this.ready) {
              this.options.enqueue(resource.metadata.name);
            }
          } catch (error) {
            reportError(error);
          }
        };
        try {
          await this.options.executeWithCapacity(async () => {
            if (this.closed || abort.signal.aborted) return;
            await source.start(Object.freeze({
              signal: abort.signal,
              emit,
              reportError,
            }));
          });
        } catch (error) {
          reportError(error);
        }
      }),
    );
    this.ready = true;
  }
}
