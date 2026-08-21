import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { PluginNamespace } from "@compforge/baton-plugin";

import { newId } from "../event/ids.ts";
import {
  parsePluginNamespace,
  pluginNamespaceTemplate,
} from "../plugin/namespace.ts";
import type { VerbRequest, VerbResponse } from "../plugin/verb.ts";
import { withFileLock } from "../store/file-lock.ts";

export type HumanActionPhase =
  | "pending"
  | "claimed"
  | "executing"
  | "pending_review"
  | "completed"
  | "dismissed";

export interface HumanInboxSession {
  readonly sessionId: string;
  readonly projectId: string;
}

export interface HumanAction {
  readonly actionId: string;
  readonly namespace: PluginNamespace;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly executionId: string;
  readonly request: VerbRequest;
  readonly phase: HumanActionPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly claimedBySessionId?: string;
  readonly transientSessionId?: string;
  readonly result?: VerbResponse;
  readonly review?: {
    readonly accepted: boolean;
    readonly sessionId: string;
    readonly reviewedAt: string;
  };
}

export type HumanInboxDelivery = "badge" | "transient" | "direct";

export interface DeliveredHumanAction {
  readonly action: HumanAction;
  readonly delivery: HumanInboxDelivery;
}

interface HumanInboxFile {
  version: 1;
  actions: Record<string, HumanAction>;
}

const EMPTY_INBOX: HumanInboxFile = { version: 1, actions: {} };

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function writeJsonAtomic(path: string, value: HumanInboxFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function copyAction(action: HumanAction): HumanAction {
  return frozenCopy(action);
}

function namespaceSession(
  namespace: PluginNamespace,
): HumanInboxSession | undefined {
  if (pluginNamespaceTemplate(namespace) !== "v1/project/session") return;
  const parts = namespace.split("/");
  return { projectId: parts[2]!, sessionId: parts[4]! };
}

export function humanActionBelongsToSession(
  action: Pick<HumanAction, "namespace">,
  session: HumanInboxSession,
): boolean {
  const namespace = parsePluginNamespace(action.namespace);
  if (namespace === "v1") return true;
  const parts = namespace.split("/");
  if (parts[2] !== session.projectId) return false;
  return parts.length === 3 || parts[4] === session.sessionId;
}

/** Durable Baton ↔ Human decision and review queue. */
export class HumanInboxStore {
  readonly path: string;
  private readonly now: () => Date;
  private readonly waiters = new Map<
    string,
    Set<(result: VerbResponse) => void>
  >();

  constructor(rootDir: string, options: { now?: () => Date } = {}) {
    this.path = join(rootDir, "inbox", "human.json");
    this.now = options.now ?? (() => new Date());
  }

  create(input: {
    namespace: PluginNamespace;
    pluginId: string;
    pluginInstanceId: string;
    executionId: string;
    request: VerbRequest;
  }): HumanAction {
    const namespace = parsePluginNamespace(input.namespace);
    return withFileLock(this.path, () => {
      const inbox = this.read();
      const timestamp = this.timestamp();
      const action: HumanAction = {
        actionId: newId("hia"),
        namespace,
        pluginId: input.pluginId,
        pluginInstanceId: input.pluginInstanceId,
        executionId: input.executionId,
        request: structuredClone(input.request),
        phase: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      inbox.actions[action.actionId] = action;
      writeJsonAtomic(this.path, inbox);
      return copyAction(action);
    });
  }

  get(actionId: string): HumanAction {
    const action = this.read().actions[actionId];
    if (!action) throw new Error(`Human Inbox action not found: ${actionId}`);
    return copyAction(action);
  }

  /** Creates one durable action before suspending the Plugin execution. */
  async request(input: {
    namespace: PluginNamespace;
    pluginId: string;
    pluginInstanceId: string;
    executionId: string;
    request: VerbRequest;
  }): Promise<VerbResponse> {
    const action = this.create(input);
    const timeoutMs = input.request.input.timeoutMs;
    return await new Promise<VerbResponse>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: VerbResponse): void => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      const waiters = this.waiters.get(action.actionId) ?? new Set();
      waiters.add(finish);
      this.waiters.set(action.actionId, waiters);
      timer = setTimeout(() => {
        const current = this.get(action.actionId);
        if (
          current.phase === "completed" ||
          current.phase === "dismissed" ||
          current.phase === "pending_review"
        ) {
          if (current.result) this.settle(action.actionId, current.result);
          return;
        }
        const result = Object.freeze({ state: "timeout" as const });
        this.update(action.actionId, (pending) => ({
          ...pending,
          phase: pending.phase === "executing" ? "pending_review" : "completed",
          result,
          updatedAt: this.timestamp(),
        }));
        this.settle(action.actionId, result);
      }, timeoutMs);
      timer.unref?.();
    });
  }

  list(options: { includeResolved?: boolean } = {}): readonly HumanAction[] {
    return Object.freeze(
      Object.values(this.read().actions)
        .filter((action) =>
          options.includeResolved ||
          (action.phase !== "completed" && action.phase !== "dismissed")
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(copyAction),
    );
  }

  /**
   * Every eligible Session receives a badge. Project/global actions nominate
   * only the first observing Session for a transient notification; a
   * session-scoped action is delivered directly to its target Session.
   */
  deliver(session: HumanInboxSession): readonly DeliveredHumanAction[] {
    return withFileLock(this.path, () => {
      const inbox = this.read();
      let changed = false;
      const delivered: DeliveredHumanAction[] = [];
      for (const action of Object.values(inbox.actions)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
        if (
          action.phase === "completed" ||
          action.phase === "dismissed" ||
          !humanActionBelongsToSession(action, session)
        ) {
          continue;
        }
        const direct = namespaceSession(action.namespace);
        let delivery: HumanInboxDelivery;
        if (direct) {
          delivery = "direct";
        } else if (!action.transientSessionId) {
          const notified = {
            ...action,
            transientSessionId: session.sessionId,
            updatedAt: this.timestamp(),
          };
          inbox.actions[action.actionId] = notified;
          changed = true;
          delivery = "transient";
          delivered.push(Object.freeze({
            action: copyAction(notified),
            delivery,
          }));
          continue;
        } else {
          delivery = action.transientSessionId === session.sessionId
            ? "transient"
            : "badge";
        }
        delivered.push(Object.freeze({ action: copyAction(action), delivery }));
      }
      if (changed) writeJsonAtomic(this.path, inbox);
      return Object.freeze(delivered);
    });
  }

  claim(actionId: string, session: HumanInboxSession): HumanAction {
    return this.update(actionId, (action) => {
      if (!humanActionBelongsToSession(action, session)) {
        throw new Error(
          `Session ${session.sessionId} cannot claim action in ${action.namespace}`,
        );
      }
      if (
        action.phase === "claimed" &&
        action.claimedBySessionId === session.sessionId
      ) {
        return action;
      }
      if (action.phase !== "pending") {
        throw new Error(`Human Inbox action ${actionId} is ${action.phase}`);
      }
      return {
        ...action,
        phase: "claimed",
        claimedBySessionId: session.sessionId,
        updatedAt: this.timestamp(),
      };
    });
  }

  beginExecution(actionId: string, sessionId: string): HumanAction {
    return this.updateClaimed(actionId, sessionId, (action) => ({
      ...action,
      phase: "executing",
      updatedAt: this.timestamp(),
    }));
  }

  complete(
    actionId: string,
    sessionId: string,
    result: VerbResponse,
    options: { review?: boolean } = {},
  ): HumanAction {
    const completed = this.updateClaimed(actionId, sessionId, (action) => ({
      ...action,
      phase: options.review ? "pending_review" : "completed",
      result: structuredClone(result),
      updatedAt: this.timestamp(),
    }));
    this.settle(actionId, result);
    return completed;
  }

  dismiss(actionId: string, sessionId: string): HumanAction {
    const dismissed = this.updateClaimed(actionId, sessionId, (action) => ({
      ...action,
      phase: "dismissed",
      result: { state: "dismissed" },
      updatedAt: this.timestamp(),
    }));
    this.settle(actionId, { state: "dismissed" });
    return dismissed;
  }

  review(
    actionId: string,
    sessionId: string,
    accepted: boolean,
  ): HumanAction {
    return this.update(actionId, (action) => {
      if (action.phase !== "pending_review") {
        throw new Error(`Human Inbox action ${actionId} is ${action.phase}`);
      }
      return {
        ...action,
        phase: "completed",
        review: {
          accepted,
          sessionId,
          reviewedAt: this.timestamp(),
        },
        updatedAt: this.timestamp(),
      };
    });
  }

  /** Releases undecided claims; an interrupted agent execution remains visible for review. */
  releaseSession(sessionId: string): readonly HumanAction[] {
    return withFileLock(this.path, () => {
      const inbox = this.read();
      const changed: HumanAction[] = [];
      for (const [actionId, action] of Object.entries(inbox.actions)) {
        if (action.claimedBySessionId !== sessionId) continue;
        let next: HumanAction | undefined;
        if (action.phase === "claimed") {
          const { claimedBySessionId: _, ...released } = action;
          next = {
            ...released,
            phase: "pending",
            updatedAt: this.timestamp(),
          };
        } else if (action.phase === "executing") {
          next = {
            ...action,
            phase: "pending_review",
            result: {
              state: "failure",
              error: "Execution Session disconnected before reporting a result",
            },
            updatedAt: this.timestamp(),
          };
        }
        if (!next) continue;
        inbox.actions[actionId] = next;
        changed.push(copyAction(next));
      }
      if (changed.length) writeJsonAtomic(this.path, inbox);
      for (const action of changed) {
        if (action.result) this.settle(action.actionId, action.result);
      }
      return Object.freeze(changed);
    });
  }

  private update(
    actionId: string,
    mutate: (action: HumanAction) => HumanAction,
  ): HumanAction {
    return withFileLock(this.path, () => {
      const inbox = this.read();
      const current = inbox.actions[actionId];
      if (!current) throw new Error(`Human Inbox action not found: ${actionId}`);
      const next = mutate(current);
      inbox.actions[actionId] = next;
      writeJsonAtomic(this.path, inbox);
      return copyAction(next);
    });
  }

  private updateClaimed(
    actionId: string,
    sessionId: string,
    mutate: (action: HumanAction) => HumanAction,
  ): HumanAction {
    return this.update(actionId, (action) => {
      if (
        (action.phase !== "claimed" && action.phase !== "executing") ||
        action.claimedBySessionId !== sessionId
      ) {
        throw new Error(
          `Human Inbox action ${actionId} is not claimed by ${sessionId}`,
        );
      }
      return mutate(action);
    });
  }

  private read(): HumanInboxFile {
    if (!existsSync(this.path)) return { ...EMPTY_INBOX, actions: {} };
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read Human Inbox ${this.path}: ${detail}`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`could not read Human Inbox ${this.path}: root must be an object`);
    }
    const inbox = value as Partial<HumanInboxFile>;
    if (
      inbox.version !== 1 ||
      !inbox.actions ||
      typeof inbox.actions !== "object" ||
      Array.isArray(inbox.actions)
    ) {
      throw new Error(`could not read Human Inbox ${this.path}: invalid schema`);
    }
    for (const action of Object.values(inbox.actions)) {
      parsePluginNamespace(action.namespace);
    }
    return inbox as HumanInboxFile;
  }

  private timestamp(): string {
    const now = this.now();
    if (Number.isNaN(now.getTime())) throw new Error("Human Inbox now() returned an invalid Date");
    return now.toISOString();
  }

  private settle(actionId: string, result: VerbResponse): void {
    const waiters = this.waiters.get(actionId);
    if (!waiters) return;
    this.waiters.delete(actionId);
    for (const resolve of waiters) resolve(frozenCopy(result));
  }
}
