import {
  appendFileSync,
  existsSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  ENVELOPE_VERSION,
  type AnyEventEnvelope,
  type EventEnvelope,
  type EventKind,
  type NewEvent,
} from "./index.ts";
import { newId } from "./ids.ts";
import { logError, type LogSink } from "../logging.ts";

export interface EventLedgerOptions {
  readonly batonSessionId: string;
  readonly path: string;
  readonly log?: LogSink;
}

/**
 * Baton 的统一事实账本。
 *
 * Event 是全局协议，Ledger 是全局内核边界；实例仍然属于一个 BatonSession。
 * 所有会改变 Core 状态或触发外部动作的路径，都应先 append 对应事实，再执行动作。
 */
export class EventLedger {
  private nextSeq: number | undefined;
  private readonly listeners = new Set<(event: AnyEventEnvelope) => void>();

  constructor(private readonly options: EventLedgerOptions) {}

  subscribe(listener: (event: AnyEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Append 是 WAL commit 点；返回前事件已经进入 session.jsonl。 */
  append<K extends EventKind>(event: NewEvent<K>): EventEnvelope<K> {
    if (this.nextSeq === undefined) {
      this.repairTail();
      const events = this.read();
      this.nextSeq = (events.at(-1)?.seq ?? 0) + 1;
    }
    const seq = this.nextSeq;
    const envelope: EventEnvelope<K> = {
      v: ENVELOPE_VERSION,
      eventId: newId("ev"),
      ts: new Date().toISOString(),
      seq,
      scope: { type: "session", batonSessionId: this.options.batonSessionId },
      ...event,
    };
    try {
      appendFileSync(this.options.path, `${JSON.stringify(envelope)}\n`);
    } catch (error) {
      this.options.log?.({
        level: "error",
        source: "baton",
        component: "ledger",
        message: "failed to append Event Ledger",
        error: logError(error),
      });
      throw error;
    }
    this.nextSeq = seq + 1;
    for (const listener of this.listeners) {
      try {
        listener(envelope as AnyEventEnvelope);
      } catch (error) {
        // Event 已经完成 WAL commit；投影失败不能反向污染写入路径。
        this.options.log?.({
          level: "error",
          source: "baton",
          component: "ledger.listener",
          message: "Event Ledger listener threw",
          error: logError(error),
          attributes: { seq: envelope.seq, kind: envelope.kind },
        });
      }
    }
    return envelope;
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
    writeFileSync(
      join(dirname(this.options.path), `session.jsonl.partial-${Date.now()}`),
      buffer.subarray(cut),
    );
    truncateSync(this.options.path, cut);
  }
}
