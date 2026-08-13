import type { StopReason } from "./event/index.ts";

interface TurnBinding {
  adapter: { harness: string };
  target: { id: string };
  laneId: string;
}

/**
 * Turn 是一次 Harness loop 的临时归属边界。Event、Attempt、Interaction 等对象
 * 通过 turnId 归入同一轮；Turn 本身不执行、排队或投递工作。
 */
export interface TurnRecord<TBinding extends TurnBinding> {
  turnId: string;
  binding: TBinding;
  harness: string;
  harnessTargetId: string;
  laneId: string;
  status: "active" | "finalized";
  startedAt: number;
  stopReason?: StopReason;
}

/**
 * Turn scope 的薄内存索引。唯一持久事实仍是 Event Ledger；这里仅供运行期按
 * turnId 找到归属并对重复终态做幂等判断。
 */
export class TurnRegistry<TBinding extends TurnBinding> {
  private readonly records = new Map<string, TurnRecord<TBinding>>();

  values(): IterableIterator<TurnRecord<TBinding>> {
    return this.records.values();
  }

  get(turnId: string): TurnRecord<TBinding> | undefined {
    return this.records.get(turnId);
  }

  open(binding: TBinding, turnId: string): TurnRecord<TBinding> {
    const existing = this.records.get(turnId);
    if (existing) return existing;
    const record: TurnRecord<TBinding> = {
      turnId,
      binding,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
      laneId: binding.laneId,
      status: "active",
      startedAt: Date.now(),
    };
    this.records.set(turnId, record);
    return record;
  }

  beginFinalization(
    turnId: string,
    stopReason: StopReason | undefined,
  ): TurnRecord<TBinding> | undefined {
    const record = this.records.get(turnId);
    if (!record || record.status === "finalized") return undefined;
    record.status = "finalized";
    record.stopReason = stopReason;
    return record;
  }
}
