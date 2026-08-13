import {
  appendFileSync,
  existsSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  type AnyEventEnvelope,
  type EventEnvelope,
  type EventKind,
} from "./index.ts";
import { logError, type LogSink } from "../logging.ts";

export interface EventLedgerOptions {
  readonly path: string;
  readonly log?: LogSink;
}

/**
 * BatonSession 的 append-only 事实记录。
 *
 * Ledger 是 WAL 和历史回放边界，不负责 reduce、调度或通知消费者。
 * 实时状态由 BatonSession 直接将同一 Event reduce 为 Projection。
 */
export class EventLedger {
  private ready = false;

  constructor(private readonly options: EventLedgerOptions) {}

  /** Record 是 WAL commit 点；Ledger 不负责 reduce、分发或通知消费者。 */
  record<K extends EventKind>(event: EventEnvelope<K>): void {
    if (!this.ready) {
      this.repairTail();
    }
    try {
      appendFileSync(this.options.path, `${JSON.stringify(event)}\n`);
      this.ready = true;
    } catch (error) {
      this.options.log?.({
        level: "error",
        source: "baton",
        component: "ledger",
        message: "failed to record Event Ledger",
        error: logError(error),
      });
      throw error;
    }
  }

  /**
   * 读取完整事件。崩溃产生的不完整末行会被忽略；中间坏行必须显式失败。
   */
  read(): AnyEventEnvelope[] {
    if (!existsSync(this.options.path)) return [];
    const lines = readFileSync(this.options.path, "utf8").split("\n");
    const events: AnyEventEnvelope[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] as string;
      if (line === "") continue;
      try {
        events.push(JSON.parse(line) as AnyEventEnvelope);
      } catch (error) {
        const isLast = lines.slice(index + 1).every((candidate) => candidate === "");
        if (isLast) break;
        throw new Error(
          `corrupt Event Ledger at line ${index + 1} in ${this.options.path}: ${error}`,
        );
      }
    }
    return events;
  }

  /** 首次追加前丢弃 crash 遗留的半行，并保留 sidecar 供诊断。 */
  private repairTail(): void {
    if (!existsSync(this.options.path)) return;
    const buffer = readFileSync(this.options.path);
    if (buffer.length === 0 || buffer[buffer.length - 1] === 0x0a) return;
    const cut = buffer.lastIndexOf(0x0a) + 1;
    const tail = buffer.subarray(cut);
    try {
      JSON.parse(tail.toString("utf8"));
      // The Event is complete; only the record separator was lost. Preserve
      // the durable fact and restore the separator before appending.
      appendFileSync(this.options.path, "\n");
      return;
    } catch {
      // A genuinely partial Event cannot be replayed and must not be joined
      // with the next append. Preserve it in a diagnostic sidecar below.
    }
    writeFileSync(
      join(dirname(this.options.path), `session.jsonl.partial-${Date.now()}`),
      tail,
    );
    truncateSync(this.options.path, cut);
  }
}
