import type { BatonTargetModelCatalog } from "@compforge/baton-plugin";
import type { HarnessTarget, HarnessTargetProbeResult } from "../harness/target.ts";

const CATALOG_TTL_MS = 60_000;

export type TargetProbe = (target: HarnessTarget) => Promise<HarnessTargetProbeResult>;

/**
 * Read-only Target observations, shared by every Plugin in this host. list stays
 * cheap for routing; get lazily refreshes discovery. One native probe at a time
 * bounds subprocess/connection use, and concurrent reads of one Target coalesce.
 */
export class TargetCatalog {
  private readonly observed = new Map<string, { value: BatonTargetModelCatalog; version: number; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<void>>();
  private tail = Promise.resolve();

  constructor(
    private readonly probe: TargetProbe | undefined,
    private readonly now: () => Date,
    private readonly onError?: (target: HarnessTarget, error: unknown) => void,
  ) {}

  snapshot(targetId: string): { value: BatonTargetModelCatalog; version: string } {
    const entry = this.observed.get(targetId);
    return { value: entry?.value ?? { phase: "Pending" }, version: String(entry?.version ?? 1) };
  }

  async refresh(target: HarnessTarget): Promise<void> {
    const entry = this.observed.get(target.id);
    if (entry && entry.expiresAt > this.now().getTime()) return;
    const pending = this.pending.get(target.id);
    if (pending) return pending;
    const work = this.tail.then(async () => {
      let value: BatonTargetModelCatalog;
      try {
        const result = await this.probe?.(target);
        const observedAt = this.now().toISOString();
        value = result?.modelCatalog === undefined
          ? { phase: "Unavailable", observedAt }
          : { phase: "Ready", observedAt, models: result.modelCatalog };
      } catch (error) {
        this.onError?.(target, error);
        value = { phase: "Failed", observedAt: this.now().toISOString(), message: "Model discovery failed; see host diagnostics" };
      }
      this.observed.set(target.id, {
        value,
        version: (entry?.version ?? 1) + 1,
        expiresAt: this.now().getTime() + CATALOG_TTL_MS,
      });
    });
    this.pending.set(target.id, work);
    this.tail = work.catch(() => {});
    try { await work; } finally { this.pending.delete(target.id); }
  }
}
