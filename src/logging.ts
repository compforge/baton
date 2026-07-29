import {
  appendFile,
  chmod,
  rename,
  rm,
  stat,
} from "node:fs/promises";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue =
  | string
  | number
  | boolean
  | null
  | readonly LogValue[]
  | Readonly<{ [key: string]: LogValue }>;

export type LogAttributes = Readonly<Record<string, LogValue>>;

export interface LogError {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: LogError;
}

export interface LogEntry {
  readonly level: LogLevel;
  readonly source: "baton" | "harness" | "plugin";
  readonly component: string;
  readonly message: string;
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly turnId?: string;
  readonly pluginId?: string;
  readonly pluginInstanceId?: string;
  readonly packageVersion?: string;
  readonly error?: LogError;
  readonly attributes?: LogAttributes;
}

/** Components submit structured records; persistence, filtering and failure isolation stay host-owned. */
export type LogSink = (entry: LogEntry) => void;

export interface SessionLoggerOptions {
  readonly level?: LogLevel;
  readonly maxBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxQueueBytes?: number;
}

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024;
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;
const MAX_STRING_CHARS = 8 * 1024;
const MAX_COLLECTION_ITEMS = 100;
const MAX_VALUE_DEPTH = 5;

/**
 * Session-owned structured NDJSON writer.
 *
 * Writes are serialized off the caller's stack, memory is bounded under bursts,
 * files are private to the current user, and one previous generation is kept.
 * Logging is best-effort by design and never changes control-flow outcomes.
 */
export class SessionLogger {
  private readonly minimumPriority: number;
  private readonly maxBytes: number;
  private readonly maxEntryBytes: number;
  private readonly maxQueueBytes: number;
  private queue: string[] = [];
  private queuedBytes = 0;
  private droppedEntries = 0;
  private draining?: Promise<void>;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly batonSessionId: string,
    options: SessionLoggerOptions = {},
  ) {
    this.minimumPriority = LEVEL_PRIORITY[options.level ?? "info"];
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.maxEntryBytes = positiveInteger(
      options.maxEntryBytes,
      DEFAULT_MAX_ENTRY_BYTES,
    );
    this.maxQueueBytes = positiveInteger(
      options.maxQueueBytes,
      DEFAULT_MAX_QUEUE_BYTES,
    );
  }

  log(entry: LogEntry): void {
    if (
      this.closed ||
      !entry ||
      LEVEL_PRIORITY[entry.level] < this.minimumPriority
    ) {
      return;
    }
    try {
      const line = this.serialize(entry);
      const bytes = Buffer.byteLength(line);
      if (bytes > this.maxQueueBytes || this.queuedBytes + bytes > this.maxQueueBytes) {
        this.droppedEntries += 1;
        return;
      }
      this.queue.push(line);
      this.queuedBytes += bytes;
      this.scheduleDrain();
    } catch {
      // Invalid diagnostics are discarded at the boundary that owns persistence.
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length > 0 || this.droppedEntries > 0) this.scheduleDrain();
    await this.draining;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  private scheduleDrain(): void {
    if (this.draining) return;
    this.draining = Promise.resolve()
      .then(() => this.drain())
      .catch(() => {
        // A diagnostic writer failure must not affect the session it observes.
      })
      .finally(() => {
        this.draining = undefined;
        if (!this.closed && (this.queue.length > 0 || this.droppedEntries > 0)) {
          this.scheduleDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 || this.droppedEntries > 0) {
      const lines = this.queue;
      const droppedEntries = this.droppedEntries;
      this.queue = [];
      this.queuedBytes = 0;
      this.droppedEntries = 0;
      if (droppedEntries > 0) {
        lines.unshift(this.serialize({
          level: "warn",
          source: "baton",
          component: "logging",
          message: "Log entries were dropped because the in-memory queue was full",
          attributes: { droppedEntries },
        }));
      }
      const batch = lines.join("");
      await this.rotateIfNeeded(Buffer.byteLength(batch));
      await appendFile(this.path, batch, { encoding: "utf8", mode: 0o600 });
      await chmod(this.path, 0o600);
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    let currentBytes = 0;
    try {
      currentBytes = (await stat(this.path)).size;
    } catch {
      return;
    }
    if (currentBytes + incomingBytes < this.maxBytes) return;
    const previous = `${this.path}.1`;
    await rm(previous, { force: true });
    await rename(this.path, previous);
    await chmod(previous, 0o600);
  }

  private serialize(entry: LogEntry): string {
    const base = {
      timestamp: new Date().toISOString(),
      batonSessionId: this.batonSessionId,
      ...normalizeLogEntry(entry),
    };
    let line = `${JSON.stringify(base)}\n`;
    if (Buffer.byteLength(line) <= this.maxEntryBytes) return line;
    line = `${JSON.stringify({
      timestamp: base.timestamp,
      batonSessionId: this.batonSessionId,
      level: entry.level,
      source: entry.source,
      component: boundedString(entry.component),
      message: boundedString(entry.message),
      ...(entry.harness ? { harness: boundedString(entry.harness) } : {}),
      ...(entry.harnessTargetId
        ? { harnessTargetId: boundedString(entry.harnessTargetId) }
        : {}),
      ...(entry.turnId ? { turnId: boundedString(entry.turnId) } : {}),
      ...(entry.pluginId ? { pluginId: boundedString(entry.pluginId) } : {}),
      ...(entry.pluginInstanceId
        ? { pluginInstanceId: boundedString(entry.pluginInstanceId) }
        : {}),
      ...(entry.packageVersion
        ? { packageVersion: boundedString(entry.packageVersion) }
        : {}),
      attributes: {
        truncated: true,
        reason: "entry exceeded maxEntryBytes",
      },
    })}\n`;
    return line;
  }
}

export function logError(
  error: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): LogError {
  if (depth >= MAX_VALUE_DEPTH) return { message: "[MaxDepth]" };
  if (error instanceof Error) {
    if (seen.has(error)) return { message: "[Circular]" };
    seen.add(error);
    return {
      name: error.name,
      message: boundedString(error.message),
      ...(error.stack ? { stack: boundedString(error.stack) } : {}),
      ...(error.cause === undefined
        ? {}
        : { cause: logError(error.cause, depth + 1, seen) }),
    };
  }
  return { message: boundedString(String(error)) };
}

function normalizeLogEntry(entry: LogEntry): LogEntry {
  return {
    level: entry.level,
    source: entry.source,
    component: boundedString(entry.component),
    message: boundedString(entry.message),
    ...(entry.harness ? { harness: boundedString(entry.harness) } : {}),
    ...(entry.harnessTargetId
      ? { harnessTargetId: boundedString(entry.harnessTargetId) }
      : {}),
    ...(entry.turnId ? { turnId: boundedString(entry.turnId) } : {}),
    ...(entry.pluginId ? { pluginId: boundedString(entry.pluginId) } : {}),
    ...(entry.pluginInstanceId
      ? { pluginInstanceId: boundedString(entry.pluginInstanceId) }
      : {}),
    ...(entry.packageVersion
      ? { packageVersion: boundedString(entry.packageVersion) }
      : {}),
    ...(entry.error ? { error: normalizeError(entry.error) } : {}),
    ...(entry.attributes
      ? { attributes: normalizeObject(entry.attributes, 0, new WeakSet()) }
      : {}),
  };
}

function normalizeError(error: LogError): LogError {
  return {
    ...(error.name ? { name: boundedString(error.name) } : {}),
    message: boundedString(error.message),
    ...(error.stack ? { stack: boundedString(error.stack) } : {}),
    ...(error.cause ? { cause: normalizeError(error.cause) } : {}),
  };
}

function normalizeObject(
  value: Readonly<Record<string, unknown>>,
  depth: number,
  seen: WeakSet<object>,
): Readonly<Record<string, LogValue>> {
  if (seen.has(value)) return { value: "[Circular]" };
  seen.add(value);
  const result: Record<string, LogValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_COLLECTION_ITEMS)) {
    result[boundedString(key)] = normalizeValue(item, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function normalizeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): LogValue {
  if (value === null) return null;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return "[undefined]";
  if (depth >= MAX_VALUE_DEPTH) return "[MaxDepth]";
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = value.slice(0, MAX_COLLECTION_ITEMS).map((item) =>
      normalizeValue(item, depth + 1, seen)
    );
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    return normalizeObject(value as Record<string, unknown>, depth, seen);
  }
  return boundedString(String(value));
}

function boundedString(value: string): string {
  return value.length <= MAX_STRING_CHARS
    ? value
    : `${value.slice(0, MAX_STRING_CHARS)}…`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : fallback;
}
