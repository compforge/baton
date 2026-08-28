// 会话存储：~/.baton/projects/<project key>/sessions/<id>/。
// Project 只负责按 cwd 组织 BatonSession；session.jsonl 承载统一逻辑历史，
// session/plugins/ 承载以该 BatonSession 为 owner 的 Plugin 数据。
// HarnessSession 元数据只用于优先恢复 harness 私有状态，缺失时仍可从 BatonSession 重建上下文。

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  type LogEntry,
  type LogLevel,
  logError,
  SessionLogger,
  type SessionLoggerOptions,
} from "../logging.ts";
import { newId } from "../event/ids.ts";
import {
  ENVELOPE_VERSION,
  textOf,
  type AnyEventDraft,
  type AnyEventEnvelope,
  type AnyNewEvent,
  type ContentBlock,
  type EventEnvelope,
  type EventKind,
  type NewEvent,
  type EventSource,
  type StopReason,
  type TurnSummary,
  type TurnSummaryToolCall,
  type UsageUpdate,
} from "../event/index.ts";
import { EventLedger } from "../event/ledger.ts";
import type { HarnessSessionIdentity } from "../harness/adapter.ts";
import { sessionIdResumeState, type HarnessResumeState } from "../harness/resume.ts";
import {
  createLaneMeta,
  createMainLaneMeta,
  MAIN_LANE_ID,
  type HarnessSessionMeta,
  type LaneMeta,
} from "../lane.ts";
import { applyEvent, reduceEvents, type SessionState } from "./reduce.ts";

/** HarnessTarget-scoped preferences are shared across Lanes, not by native sessions. */
export interface HarnessTargetMeta {
  harnessTargetId: string;
  harness: string;
  model?: string;
  effort?: string;
  mode?: string;
}

/** Session-level desired routing target. HarnessSession bindings remain Lane × Target owned. */
export interface SessionTargetBindingMeta {
  readonly targetId?: string;
  readonly generation: number;
  readonly resourceVersion: number;
  readonly updatedAt: string;
}

/** 0.2.21 and earlier stored Target preferences and one native binding together. */
export interface LegacyHarnessSessionMeta extends HarnessSessionMeta {
  harnessTargetId: string;
  model?: string;
  effort?: string;
  mode?: string;
}

/** fork 谱系：child 复制了哪个会话、复制到哪个事件水位（将来从消息 fork 时即边界）。 */
export interface SessionForkOrigin {
  batonSessionId: string;
  /** 源会话中被复制历史的最后一个事件 seq */
  throughSeq: number;
}

/** 从 HarnessSession 接入 Baton 时的不可变来源坐标。 */
export interface AdoptedHarnessSession {
  harnessTargetId: string;
  harness: string;
  identity: HarnessSessionIdentity;
}

/**
 * 某一段 Harness 历史前缀的内容边界。digest 覆盖从首轮到 turnCount 的完整语义投影，
 * 因而能发现早期工具/推理/计划事实被旁路改写，而不只比较最后一轮文本。
 */
export interface HarnessHistoryBoundary {
  /** digest 语义版本；算法或归一投影变化时递增，禁止拿不同版本直接比较。 */
  version: 1;
  turnId?: string;
  turnCount: number;
  prefixDigest: string;
}

export interface HarnessSessionAdoption {
  session: AdoptedHarnessSession;
  importedThrough: HarnessHistoryBoundary;
}

/** @deprecated 仅用于读取 0.2.14 及更早版本的 meta。 */
export interface NativeSessionOrigin {
  harnessTargetId: string;
  harness: string;
  nativeSessionId: string;
}

export interface SessionMeta {
  batonSessionId: string;
  /** Session 名称：可由用户显式指定；fork 未命名时由第一条 queue 补齐。 */
  title?: string;
  /** 第一条真实用户输入的紧凑预览，只写一次；供 resume/list/@ 发现会话。 */
  preview?: string;
  /** 会话名称之外的补充说明；fork session 用它快照来源会话。 */
  description?: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  /** harnessTargetId → shared Target preferences. */
  harnessTargets: Record<string, HarnessTargetMeta>;
  /** Core-owned desired route exposed as SessionTargetBinding. */
  targetBinding?: SessionTargetBindingMeta;
  /** Baton-native task lines. A Lane may traverse multiple HarnessTargets. */
  lanes: Record<string, LaneMeta>;
  /** @deprecated in-memory compatibility projection; omitted from new meta.json writes. */
  harnessSessions: Record<string, LegacyHarnessSessionMeta>;
  forkedFrom?: SessionForkOrigin;
  /** 首次 adoption 的 HarnessSession 永不随当前执行 binding 改写。 */
  adoptedFrom?: HarnessSessionAdoption;
  /** @deprecated 读取时迁移到 adoptedFrom；新写入不再产生。 */
  nativeSessionOrigin?: NativeSessionOrigin;
}

export function sessionTargetBindingMeta(
  meta: Pick<SessionMeta, "createdAt" | "targetBinding">,
): SessionTargetBindingMeta {
  return meta.targetBinding ?? Object.freeze({
    generation: 1,
    resourceVersion: 1,
    updatedAt: meta.createdAt,
  });
}

/** 可读 basename + cwd 摘要；避免旧版纯字符替换把不同 cwd 放进同一项目目录。 */
export function projectDirName(cwd: string): string {
  const canonical = resolve(cwd);
  const readable = (basename(canonical).replace(/[^a-zA-Z0-9._-]/g, "-") || "project").slice(
    0,
    80,
  );
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

const SESSION_PREVIEW_MAX_CHARS = 100;
const SESSION_PREVIEW_SCAN_BYTES = 256 * 1024;

/** 对齐 Codex resume：取第一条有效用户输入的首个非空行，并做有界字符截断。 */
export function sessionPreview(text: string): string | undefined {
  const firstLine = stripBatonInjectedContext(text)
    .split(/\r?\n/)
    // chat-tui 的图片粘贴目前以本地路径进入文本；它是附件，不是可辨识的会话名称。
    .map((line) =>
      line
        .trim()
        .replace(/^\/\S+\.(?:avif|bmp|gif|jpe?g|png|tiff?|webp)(?:\s+|$)/i, "")
        .trim(),
    )
    .find(Boolean);
  if (!firstLine) return undefined;
  const chars = [...firstLine];
  return chars.length <= SESSION_PREVIEW_MAX_CHARS
    ? firstLine
    : `${chars.slice(0, SESSION_PREVIEW_MAX_CHARS - 3).join("")}...`;
}

/** 旧版本自动写入的标题不是用户命名，展示时应让位给 conversation preview。 */
function explicitSessionTitle(meta: SessionMeta): string | undefined {
  const title = meta.title?.trim();
  if (!title) return undefined;
  // 冻结的 legacy 集合：匹配的是历史版本写入的自动标题，刻意不从 harness registry
  // 派生——将来新增 harness 不会产生这种标题，跟随 registry 反而会误伤同名用户标题。
  const generated = ["chat", "codex", "claude", "claude-code"].flatMap((agent) => {
    const base = `${agent} @ ${meta.cwd}`;
    return [base, `${base} (fork)`];
  });
  return generated.includes(title) ? undefined : title;
}

export function sessionDisplayTitle(meta: SessionMeta): string {
  const explicitTitle = explicitSessionTitle(meta);
  if (meta.forkedFrom) {
    return explicitTitle ?? meta.description?.trim() ?? `fork: chat @ ${meta.cwd}`;
  }
  return explicitTitle ?? meta.preview?.trim() ?? meta.description?.trim() ?? `chat @ ${meta.cwd}`;
}

function normalizeSessionMeta(meta: SessionMeta): SessionMeta {
  const harnessTargets = { ...(meta.harnessTargets ?? {}) };
  const lanes = { ...(meta.lanes ?? {}) };
  const mainLane = lanes[MAIN_LANE_ID] ?? createMainLaneMeta();
  lanes[MAIN_LANE_ID] = mainLane;

  for (const [harnessTargetId, legacy] of Object.entries(meta.harnessSessions ?? {})) {
    harnessTargets[harnessTargetId] ??= {
      harnessTargetId,
      harness: legacy.harness,
      ...(legacy.model === undefined ? {} : { model: legacy.model }),
      ...(legacy.effort === undefined ? {} : { effort: legacy.effort }),
      ...(legacy.mode === undefined ? {} : { mode: legacy.mode }),
    };
    mainLane.harnessSessions[harnessTargetId] ??= {
        harness: legacy.harness,
        ...(legacy.launchSnapshot === undefined
          ? {}
          : { launchSnapshot: legacy.launchSnapshot }),
        ...(legacy.harnessSessionId === undefined
          ? {}
          : { harnessSessionId: legacy.harnessSessionId }),
        ...(legacy.resumeState === undefined ? {} : { resumeState: legacy.resumeState }),
        ...(legacy.resumeCursor === undefined ? {} : { resumeCursor: legacy.resumeCursor }),
        ...(legacy.contextEpochId === undefined
          ? {}
          : { contextEpochId: legacy.contextEpochId }),
        ...(legacy.syncedSeq === undefined ? {} : { syncedSeq: legacy.syncedSeq }),
        ...(legacy.parentSessionId === undefined
          ? {}
          : { parentSessionId: legacy.parentSessionId }),
    };
  }

  const {
    harnessSessions: _legacy,
    mainLaneId: _legacyMainLaneId,
    harnessLanes: _obsoleteHarnessLanes,
    interactiveLaneByTarget: _obsoleteInteractiveLanes,
    ...current
  } = meta as SessionMeta & {
    mainLaneId?: unknown;
    harnessLanes?: unknown;
    interactiveLaneByTarget?: unknown;
  };
  const harnessSessions = Object.fromEntries(
    Object.entries(harnessTargets).map(([harnessTargetId, target]) => {
      const session = mainLane.harnessSessions[harnessTargetId];
      return [
        harnessTargetId,
        {
          ...session,
          harnessTargetId,
          harness: session?.harness ?? target.harness,
          ...(target.model === undefined ? {} : { model: target.model }),
          ...(target.effort === undefined ? {} : { effort: target.effort }),
          ...(target.mode === undefined ? {} : { mode: target.mode }),
        } satisfies LegacyHarnessSessionMeta,
      ];
    }),
  );
  return {
    ...current,
    harnessTargets,
    lanes,
    harnessSessions,
  };
}

export interface NativeSessionMaterialization {
  harnessTargetId: string;
  harness: string;
  nativeSessionId: string;
  cwd: string;
  title?: string;
  turns: HarnessHistoryTurn[];
}

export interface HarnessHistoryEvent {
  source: "user" | "baton" | "harness";
  event: AnyEventDraft;
}

export interface HarnessHistoryTurn {
  /** Harness 中该 turn 的稳定 id；旧 Provider 缺失时用快照内位置兼容。 */
  turnId?: string;
  userText?: string;
  agentText?: string;
  /** Harness 已归一的完整 turn；缺省时兼容只提供 user/assistant 文本的 provider。 */
  events?: HarnessHistoryEvent[];
}

export interface HarnessSessionAdoptionSource {
  session: AdoptedHarnessSession;
  cwd: string;
  title?: string;
  turns: HarnessHistoryTurn[];
  observedThrough: HarnessHistoryBoundary;
}

/** @deprecated 0.2.14 public type aliases. */
export type NativeSessionMaterializationEvent = HarnessHistoryEvent;
export type NativeSessionMaterializationTurn = HarnessHistoryTurn;

function previewFromSessionLog(dir: string): string | undefined {
  const path = join(dir, "session.jsonl");
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SESSION_PREVIEW_SCAN_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytes);
    const lastNewline = text.lastIndexOf("\n");
    const complete = bytes < buffer.length ? text : lastNewline >= 0 ? text.slice(0, lastNewline) : "";
    for (const line of complete.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as AnyEventEnvelope;
        if (event.kind !== "user_message" || event.source.type === "plugin") {
          continue;
        }
        const payload = event.payload as { content?: ContentBlock[] };
        const preview = sessionPreview(textOf(payload.content ?? []));
        if (preview) return preview;
      } catch {
        // 有界扫描只用于旧会话的展示回填；单行损坏不应让整个 session picker 失败。
      }
    }
  } finally {
    closeSync(fd);
  }
  return undefined;
}

function withSessionPreview(dir: string, meta: SessionMeta): SessionMeta {
  if (meta.preview?.trim()) return meta;
  const preview = previewFromSessionLog(dir);
  return preview ? { ...meta, preview } : meta;
}

export class SessionStore {
  readonly rootDir: string;
  private legacyMigrated = false;
  private readonly loggerOptions: SessionLoggerOptions;

  constructor(
    rootDir?: string,
    loggerOptions: { readonly level?: LogLevel } = {},
  ) {
    this.rootDir = rootDir ?? join(homedir(), ".baton");
    this.loggerOptions = loggerOptions;
  }

  private projectsDir(): string {
    return join(this.rootDir, "projects");
  }

  /**
   * 旧布局（~/.baton/sessions/<id> 和 projects/<cwd escaped>/<id>）一次性迁移到
   * projects/<project key>/sessions/<id>。
   * meta 缺失或损坏的目录原地保留，不阻塞正常使用。
   */
  private migrateLegacySessions(): void {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    const flatLegacy = join(this.rootDir, "sessions");
    this.migrateSessionsFrom(flatLegacy);
    this.removeIfEmpty(flatLegacy);

    for (const projectDir of this.listProjectDirs()) {
      this.migrateSessionsFrom(projectDir);
      this.removeIfEmpty(projectDir);
    }
  }

  createSession(opts: { cwd: string; title?: string }): SessionHandle {
    this.migrateLegacySessions();
    const id = newId("bs");
    const cwd = resolve(opts.cwd);
    const dir = this.sessionDir(cwd, id);
    this.ensureProject(cwd);
    mkdirSync(dir, { recursive: true });
    const meta: SessionMeta = {
      batonSessionId: id,
      title: opts.title,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      harnessTargets: {},
      lanes: {
        [MAIN_LANE_ID]: createMainLaneMeta(),
      },
      harnessSessions: {},
    };
    writeMetaAtomic(dir, meta);
    return new SessionHandle(id, dir, meta, this.loggerOptions);
  }

  /** 把只读 HarnessHistorySnapshot 接入唯一 BatonSession owner。 */
  adoptHarnessSession(
    source: HarnessSessionAdoptionSource,
  ): { session: SessionHandle; reused: boolean } {
    assertObservedBoundary(source);
    const release = this.acquireHarnessSessionAdoptionLock();
    try {
      const existing = this.findByHarnessSession(source.session);
      if (existing) {
        const session = this.openSession(existing.batonSessionId);
        const ownsLock = session.acquireLock();
        try {
          this.reconcileHarnessSession(session, source);
        } finally {
          if (ownsLock) session.releaseLock();
        }
        return { session, reused: true };
      }
      return { session: this.createFromHarnessSession(source), reused: false };
    } finally {
      release();
    }
  }

  /** @deprecated 0.2.14 Provider 兼容入口；新调用方传 HarnessHistorySnapshot。 */
  materializeNativeSession(
    source: NativeSessionMaterialization,
  ): { session: SessionHandle; reused: boolean } {
    return this.adoptHarnessSession({
      session: {
        harnessTargetId: source.harnessTargetId,
        harness: source.harness,
        identity: { id: source.nativeSessionId },
      },
      cwd: source.cwd,
      title: source.title,
      turns: source.turns,
      observedThrough: harnessHistoryBoundary(source.turns),
    });
  }

  private createFromHarnessSession(source: HarnessSessionAdoptionSource): SessionHandle {
    const session = this.createSession({ cwd: source.cwd, title: source.title });
    const { harnessTargetId, harness, identity } = source.session;
    const laneId = session.ensureMainLane().laneId;
    const label = source.title?.trim() || identity.id;
    let syncedSeq = 0;
    for (const turn of source.turns) {
      syncedSeq = this.appendMaterializedTurn(session, source, turn);
    }
    // 不可变来源、已导入边界与当前 binding 必须原子出现，避免崩溃留下半个 owner。
    session.updateMeta({
      description: `import: ${harness} ${label}`,
      adoptedFrom: {
        session: source.session,
        importedThrough: source.observedThrough,
      },
      harnessTargets: {
        [harnessTargetId]: { harnessTargetId, harness },
      },
      lanes: {
        [laneId]: {
          ...session.meta.lanes[laneId]!,
          harnessSessions: {
            [harnessTargetId]: {
            harness,
            harnessSessionId: identity.id,
            resumeState: sessionIdResumeState(identity.id),
            contextEpochId: newId("ctxe"),
            // HarnessSession 已亲历这些历史 turn；同 Lane resume 时不能再注入一遍。
            syncedSeq,
            },
          },
        },
      },
    });
    return session;
  }

  /**
   * 再次 adoption 时先对账完整语义前缀，再只追加 Harness 新增尾部。当前 execution binding
   * 可以重建或切换，但 adoptedFrom 始终指向第一次接入的 HarnessSession。
   */
  private reconcileHarnessSession(
    session: SessionHandle,
    source: HarnessSessionAdoptionSource,
  ): void {
    const { harnessTargetId, harness, identity } = source.session;
    const summaries = session.ledger
      .read()
      .filter(
        (event): event is EventEnvelope<"_baton_turn_summary"> =>
          event.kind === "_baton_turn_summary" &&
          event.harnessTargetId === harnessTargetId,
      );
    if (summaries.length > source.turns.length) {
      throw new Error(
        `HarnessSession history is behind its Baton owner for ${harnessTargetId}/${identity.id}`,
      );
    }

    const existingTurns = materializedHistoryTurns(session, summaries);
    for (let count = 1; count <= summaries.length; count++) {
      const existing = existingTurns[count - 1]!;
      const incoming = source.turns[count - 1]!;
      const diverged = incoming.events
        ? harnessHistoryTurnDigest(existing) !== harnessHistoryTurnDigest(incoming)
        : comparableTurnText(existing.userText) !== comparableTurnText(incoming.userText) ||
          comparableTurnText(existing.agentText) !== comparableTurnText(incoming.agentText);
      if (diverged) {
        throw new Error(
          `HarnessSession history diverged at turn ${count} for ${harnessTargetId}/${identity.id}`,
        );
      }
    }

    const importedThrough = adoptionFor(session.meta)?.importedThrough;
    if (importedThrough) {
      const incomingImported = harnessHistoryBoundary(
        source.turns,
        importedThrough.turnCount,
      );
      if (
        incomingImported.version !== importedThrough.version ||
        incomingImported.turnCount !== importedThrough.turnCount ||
        incomingImported.turnId !== importedThrough.turnId ||
        incomingImported.prefixDigest !== importedThrough.prefixDigest
      ) {
        throw new Error(
          `HarnessSession imported history boundary diverged for ${harnessTargetId}/${identity.id}`,
        );
      }
    }

    let syncedSeq = summaries.at(-1)?.seq ?? 0;
    for (const turn of source.turns.slice(summaries.length)) {
      syncedSeq = this.appendMaterializedTurn(session, source, turn);
    }

    const laneId = session.ensureMainLane().laneId;
    const lane = session.meta.lanes[laneId]!;
    const existing = lane.harnessSessions[harnessTargetId];
    session.updateMeta({
      adoptedFrom: {
        session: source.session,
        importedThrough: source.observedThrough,
      },
      harnessTargets: {
        ...session.meta.harnessTargets,
        [harnessTargetId]: {
          ...session.meta.harnessTargets[harnessTargetId],
          harnessTargetId,
          harness,
        },
      },
      lanes: {
        ...session.meta.lanes,
        [laneId]: {
          ...lane,
          harnessSessions: {
            ...lane.harnessSessions,
            [harnessTargetId]: {
              ...existing,
              harness,
              harnessSessionId: identity.id,
              resumeState: sessionIdResumeState(identity.id),
              contextEpochId: existing?.contextEpochId ?? newId("ctxe"),
              syncedSeq,
            },
          },
        },
      },
    });
  }

  private appendMaterializedTurn(
    session: SessionHandle,
    source: Pick<HarnessSessionAdoptionSource, "session">,
    turn: HarnessHistoryTurn,
  ): number {
    const { harnessTargetId, harness } = source.session;
    const laneId = session.ensureMainLane().laneId;
    const turnId = newId("t");
    if (turn.userText) session.setPreviewIfEmpty(turn.userText);

    if (turn.events) {
      for (const imported of turn.events) {
        session.appendEvent({
          ...imported.event,
          source: materializedEventSource(imported.source, harnessTargetId),
          harness,
          harnessTargetId,
          laneId,
          turnId,
        } as AnyNewEvent);
      }
    } else {
      if (turn.userText) {
        session.appendEvent({
          kind: "user_message",
          source: { type: "user" },
          harness,
          harnessTargetId,
          laneId,
          turnId,
          payload: {
            messageId: newId("m"),
            content: [{ type: "text", text: turn.userText }],
          },
        });
      }
      if (turn.agentText) {
        session.appendEvent({
          kind: "agent_message",
          source: { type: "harness", harnessTargetId },
          harness,
          harnessTargetId,
          laneId,
          turnId,
          payload: {
            messageId: newId("m"),
            content: [{ type: "text", text: turn.agentText }],
          },
        });
      }
      session.appendEvent({
        kind: "state_update",
        source: { type: "harness", harnessTargetId },
        harness,
        harnessTargetId,
        laneId,
        turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
    }
    return session.summarizeTurnEvent(turnId).seq;
  }

  /** 会话 ID 全局唯一，打开时不要求提供 cwd，跨项目扫描定位（@ 引用可指向任意项目的会话）。 */
  openSession(id: string): SessionHandle {
    this.migrateLegacySessions();
    for (const projectDir of this.listProjectDirs()) {
      const dir = join(projectDir, "sessions", id);
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta & {
        mainLaneId?: unknown;
      };
      const meta = withSessionPreview(dir, normalizeSessionMeta(parsed));
      if (
        parsed.harnessSessions ||
        !parsed.harnessTargets ||
        !parsed.lanes ||
        parsed.mainLaneId !== undefined
      ) {
        writeMetaAtomic(dir, meta);
      }
      return new SessionHandle(id, dir, meta, this.loggerOptions);
    }
    throw new Error(`baton session not found: ${id}`);
  }

  listSessions(opts: { cwd?: string } = {}): SessionMeta[] {
    this.migrateLegacySessions();
    const cwd = opts.cwd === undefined ? undefined : resolve(opts.cwd);
    const projectDirs =
      cwd !== undefined
        ? [this.projectDir(cwd)]
        : this.listProjectDirs();
    const out: SessionMeta[] = [];
    for (const projectDir of projectDirs) {
      const sessionsDir = join(projectDir, "sessions");
      if (!existsSync(sessionsDir)) continue;
      for (const name of readdirSync(sessionsDir)) {
        const sessionDir = join(sessionsDir, name);
        const metaPath = join(sessionDir, "meta.json");
        if (!existsSync(metaPath)) continue;
        try {
          const meta = withSessionPreview(
            sessionDir,
            normalizeSessionMeta(JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta),
          );
          if (cwd !== undefined && meta.cwd !== cwd) continue;
          out.push(meta);
        } catch {
          // 损坏的 meta 不阻塞列表
        }
      }
    }
    out.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    return out;
  }

  /** Read-only liveness observation for Session Resource projection. */
  isSessionActive(meta: Pick<SessionMeta, "batonSessionId" | "cwd">): boolean {
    const path = join(this.sessionDir(resolve(meta.cwd), meta.batonSessionId), "lock");
    try {
      const holder = Number(readFileSync(path, "utf8").trim());
      return Number.isFinite(holder) && holder > 0 && pidAlive(holder);
    } catch {
      return false;
    }
  }

  /** adoptedFrom 是 owner 索引；当前 mutable binding 只为尚未 adoption 的 Baton 会话兜底。 */
  findByHarnessSession(source: AdoptedHarnessSession): SessionMeta | undefined {
    const { harnessTargetId, harness, identity } = source;
    const matches = this.listSessions().filter((meta) => {
      const adoption = adoptionFor(meta);
      if (adoption) {
        return (
          adoption.session.harnessTargetId === harnessTargetId &&
          adoption.session.harness === harness &&
          adoption.session.identity.id === identity.id
        );
      }
      return Object.values(meta.lanes).some(
        (lane) => {
          const session = lane.harnessSessions[harnessTargetId];
          return session?.harness === harness && session.harnessSessionId === identity.id;
        },
      );
    });
    if (matches.length > 1) {
      const owners = matches.map((meta) => meta.batonSessionId).join(", ");
      throw new Error(
        `HarnessSession ${harnessTargetId}/${identity.id} is owned by multiple BatonSessions: ${owners}`,
      );
    }
    return matches[0];
  }

  /** @deprecated 使用 findByHarnessSession。 */
  findByNativeSession(harnessTargetId: string, nativeSessionId: string): SessionMeta | undefined {
    const harness = this.listSessions()
      .map((meta) => meta.harnessTargets[harnessTargetId]?.harness)
      .find(Boolean);
    if (!harness) return undefined;
    return this.findByHarnessSession({
      harnessTargetId,
      harness,
      identity: { id: nativeSessionId },
    });
  }

  /**
   * Fork 一个 BatonSession：把 throughSeq（默认 head）之前的事件历史复制进新会话。
   * 复制的前缀与源是同一段逻辑历史（git-branch 语义）：seq 与 turn/message/toolCall/
   * interaction 等领域对象 ID 原样保留，只换 session scope。Event 是 ledger append 的身份，
   * 换 scope 时重新签发 eventId，保证一个 eventId 只属于一个权威 ledger。
   * 谱系由 meta.forkedFrom 表达。
   * child 继承 HarnessTarget 偏好和逻辑 Lane 拓扑，但清空所有原生 session binding
   * （否则两个 BatonSession 会写进同一份 Harness 历史）；child 首次使用某个
   * Lane × Target 时创建 fresh native session + 新 ContextEpoch，并从复制历史补课。
   * opts.cwd 支持跨 project fork：历史跟源走，project 归属跟 fork 发起位置走；
   * 缺省沿用源 cwd。
   */
  forkSession(
    sourceSessionId: string,
    opts: { title?: string; throughSeq?: number; cwd?: string } = {},
  ): SessionHandle {
    const source = this.openSession(sourceSessionId);
    const events = source.ledger
      .read()
      .filter((ev) => opts.throughSeq === undefined || ev.seq <= opts.throughSeq);
    const id = newId("bs");
    // 落盘目录与 meta.cwd 必须同源：listSessions({cwd}) 按目录扫描，两者不一致会漏掉该会话
    const cwd = resolve(opts.cwd ?? source.meta.cwd);
    const dir = this.sessionDir(cwd, id);
    this.ensureProject(cwd);
    mkdirSync(dir, { recursive: true });
    if (events.length > 0) {
      const lines = events.map((ev) =>
        JSON.stringify({
          ...ev,
          eventId: newId("ev"),
          scope: { type: "session", batonSessionId: id },
        }),
      );
      writeFileSync(join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
    }
    const harnessTargets = Object.fromEntries(
      Object.entries(source.meta.harnessTargets).map(([key, target]) => [
        key,
        { ...target },
      ]),
    );
    const now = new Date().toISOString();
    const sourceQuestion = source.meta.preview?.trim() ?? sessionDisplayTitle(source.meta);
    const lanes = Object.fromEntries(
      Object.entries(source.meta.lanes).map(([laneId, lane]) => [
        laneId,
        createLaneMeta({
          laneId,
          createdFor: lane.createdFor,
          parentLaneId: lane.parentLaneId,
        }),
      ]),
    );
    const meta: SessionMeta = {
      batonSessionId: id,
      title: opts.title,
      description: `fork: ${sourceQuestion}`,
      cwd,
      createdAt: now,
      updatedAt: now,
      harnessTargets,
      lanes,
      harnessSessions: {},
      forkedFrom: { batonSessionId: sourceSessionId, throughSeq: events.at(-1)?.seq ?? 0 },
    };
    writeMetaAtomic(dir, meta);
    return new SessionHandle(id, dir, meta, this.loggerOptions);
  }

  private listProjectDirs(): string[] {
    const dir = this.projectsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  }

  private projectDir(cwd: string): string {
    return join(this.projectsDir(), projectDirName(cwd));
  }

  private sessionDir(cwd: string, sessionId: string): string {
    return join(this.projectDir(cwd), "sessions", sessionId);
  }

  private acquireHarnessSessionAdoptionLock(): () => void {
    mkdirSync(this.rootDir, { recursive: true });
    // 沿用 0.2.14 锁文件名，保证滚动升级时新旧进程仍竞争同一把 owner 创建锁。
    const path = join(this.rootDir, "native-session.lock");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => {
          try {
            if (readFileSync(path, "utf8").trim() === String(process.pid)) {
              rmSync(path);
            }
          } catch {
            // 锁已被清理时无需额外动作。
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let holder: number;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        continue;
      }
      if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) {
        throw new Error(`another baton process is adopting a HarnessSession (pid ${holder})`);
      }
      rmSync(path, { force: true });
    }
    throw new Error("failed to acquire HarnessSession adoption lock");
  }

  private ensureProject(cwd: string): void {
    const projectDir = this.projectDir(cwd);
    const path = join(projectDir, "project.json");
    mkdirSync(join(projectDir, "sessions"), { recursive: true });
    if (existsSync(path)) {
      const project = JSON.parse(readFileSync(path, "utf8")) as { cwd?: unknown };
      if (project.cwd !== cwd) {
        throw new Error(`project directory ${projectDir} belongs to another cwd`);
      }
      return;
    }
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ cwd }, null, 2)}\n`);
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private migrateSessionsFrom(sourceDir: string): void {
    if (!existsSync(sourceDir)) return;
    for (const name of readdirSync(sourceDir)) {
      const source = join(sourceDir, name);
      const metaPath = join(source, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
        const cwd = resolve(meta.cwd);
        const destination = this.sessionDir(cwd, name);
        this.ensureProject(cwd);
        if (source !== destination) renameSync(source, destination);
      } catch {
        // 留在原目录，避免把无法解析或发生身份冲突的会话搬到错误项目。
      }
    }
  }

  private removeIfEmpty(dir: string): void {
    try {
      rmdirSync(dir);
    } catch {
      // 损坏会话或新布局内容仍在时保留。
    }
  }
}

function writeMetaAtomic(dir: string, meta: SessionMeta): void {
  const tmp = join(dir, "meta.json.tmp");
  const { harnessSessions: _compatibilityProjection, ...persisted } = meta;
  writeFileSync(tmp, JSON.stringify(persisted, null, 2));
  renameSync(tmp, join(dir, "meta.json"));
}

export class SessionHandle {
  readonly id: string;
  readonly dir: string;
  readonly logger: SessionLogger;
  readonly ledger: EventLedger;
  private readonly eventListeners = new Set<(event: AnyEventEnvelope) => void>();
  private state: SessionState;
  private nextEventSeq: number;
  meta: SessionMeta;

  constructor(
    id: string,
    dir: string,
    meta: SessionMeta,
    loggerOptions: SessionLoggerOptions = {},
  ) {
    this.id = id;
    this.dir = dir;
    this.meta = normalizeSessionMeta(meta);
    this.logger = new SessionLogger(
      join(this.dir, "session.log"),
      this.id,
      loggerOptions,
    );
    this.ledger = new EventLedger({
      path: join(this.dir, "session.jsonl"),
      log: (entry) => this.log(entry),
    });
    const history = this.ledger.read();
    this.state = reduceEvents(history);
    this.nextEventSeq = (history.at(-1)?.seq ?? 0) + 1;
  }

  /** Current Core projection. Live events and replay both use the same reducer. */
  get projection(): SessionState {
    return this.state;
  }

  /** Observe accepted Session events after they have been recorded and reduced. */
  subscribe(listener: (event: AnyEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * BatonSession 的统一 Event 入口。当前策略先完成 WAL record，再直接 reduce；
   * Ledger 只是 Recorder，不承担实时分发。
   */
  appendEvent<K extends EventKind>(event: NewEvent<K>): EventEnvelope<K> {
    const envelope: EventEnvelope<K> = {
      v: ENVELOPE_VERSION,
      eventId: newId("ev"),
      ts: new Date().toISOString(),
      seq: this.nextEventSeq,
      scope: { type: "session", batonSessionId: this.id },
      ...event,
    };
    this.ledger.record(envelope);
    this.nextEventSeq += 1;
    applyEvent(this.state, envelope as AnyEventEnvelope);
    for (const listener of this.eventListeners) {
      try {
        listener(envelope as AnyEventEnvelope);
      } catch (error) {
        this.log({
          level: "error",
          source: "baton",
          component: "session.event",
          message: "BatonSession event listener threw",
          error: logError(error),
          attributes: { seq: envelope.seq, kind: envelope.kind },
        });
      }
    }
    return envelope;
  }

  /**
   * Structured operational logs are deliberately separate from the event ledger:
   * they support diagnosis, not replay or product state.
   */
  log(entry: LogEntry): void {
    this.logger.log(entry);
  }

  async flushLogs(): Promise<void> {
    await this.logger.flush();
  }

  async closeLogs(): Promise<void> {
    await this.logger.close();
  }

  /**
   * Provider 原生入站消息的旁路 NDJSON。与 session.log 分开，避免高频 wire trace
   * 淹没错误诊断；单文件到 10 MiB 后保留一份上一代。失败不影响正典事件流。
   */
  nativeEvent(
    harnessTargetId: string,
    harness: string,
    event: { direction: "in"; name?: string; payload: unknown },
    laneId?: string,
  ): void {
    try {
      const safeTarget = harnessTargetId.replace(/[^a-zA-Z0-9._-]/g, "-");
      const safeLane = laneId?.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = join(
        this.dir,
        `native-${safeTarget}${safeLane ? `-${safeLane}` : ""}.jsonl`,
      );
      if (existsSync(path) && statSync(path).size >= 10 * 1024 * 1024) {
        renameSync(path, `${path}.1`);
        chmodSync(`${path}.1`, 0o600);
      }
      appendFileSync(
        path,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          batonSessionId: this.id,
          harnessTargetId,
          ...(laneId ? { laneId } : {}),
          harness,
          ...event,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(path, 0o600);
    } catch {
      // 原生 trace 只服务协议排障，不能反向影响 Harness 执行。
    }
  }

  private lockPath(): string {
    return join(this.dir, "lock");
  }

  /**
   * 会话独占锁（pid 文件）。存在的意义是给 crash recovery 提供写入前提：
   * "最后事件是 running"只有在没有活进程持有会话时才能断定为崩溃残留，
   * 否则往活会话里合成终态会污染它。不承担并发追加的完整保护。
   * 同进程重入直接通过，且不做引用计数——约定同一进程内一个 session 至多
   * 一个活 handle（TUI 单前台会话；将来多 Session Controller 由 session slot
   * 唯一性保证），进程内并发归上层，锁只管跨进程。返回 true 表示本次新建了锁，
   * 调用方应负责释放；false 表示同进程已持有，不能替原 owner 释放。
   */
  acquireLock(): boolean {
    const path = this.lockPath();
    // 每轮要么 O_EXCL 原子创建成功，要么排除一个失效持有者再试；
    // 不用 existsSync 预检查——检查与创建之间的窗口就是 TOCTOU。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let holder: number;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        continue; // 持有者恰在此刻释放了锁，直接重试创建
      }
      if (holder === process.pid) return false; // 同进程重入
      if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) {
        throw new Error(`baton session ${this.id} is in use by another baton process (pid ${holder})`);
      }
      rmSync(path, { force: true }); // 持有者已死（或锁内容损坏）：清除 stale 锁重试
    }
    throw new Error(`failed to acquire session lock for ${this.id} after retries`);
  }

  /** 只释放自己持有的锁；释放失败不阻塞退出（stale 锁由下次 acquire 的存活判定接管）。 */
  releaseLock(): void {
    try {
      const path = this.lockPath();
      if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
        rmSync(path);
      }
    } catch {
      // 见 docstring：宁可留 stale 锁也不在退出路径抛错
    }
  }

  loadState(): SessionState {
    return reduceEvents(this.ledger.read());
  }

  updateMeta(patch: Partial<Omit<SessionMeta, "batonSessionId">>): void {
    this.meta = normalizeSessionMeta({ ...this.meta, ...patch });
    writeMetaAtomic(this.dir, this.meta);
  }

  setTargetBinding(
    targetId: string | undefined,
    expectedResourceVersion: string,
    now = new Date(),
  ): SessionTargetBindingMeta {
    const current = sessionTargetBindingMeta(this.meta);
    if (String(current.resourceVersion) !== expectedResourceVersion) {
      throw new Error(
        `SessionTargetBinding resource version conflict: expected ${expectedResourceVersion}, current ${current.resourceVersion}`,
      );
    }
    if (current.targetId === targetId) return current;
    if (targetId !== undefined && !targetId.trim()) {
      throw new Error("SessionTargetBinding targetId must not be empty");
    }
    if (Number.isNaN(now.getTime())) {
      throw new Error("SessionTargetBinding now must be a valid Date");
    }
    const next = Object.freeze({
      ...(targetId === undefined ? {} : { targetId }),
      generation: current.generation + 1,
      resourceVersion: current.resourceVersion + 1,
      updatedAt: now.toISOString(),
    });
    this.updateMeta({ targetBinding: next });
    return next;
  }

  setPreviewIfEmpty(text: string): void {
    if (this.meta.preview?.trim()) return;
    const preview = sessionPreview(text);
    if (preview) this.updateMeta({ preview });
  }

  setTitleIfEmpty(text: string): void {
    if (this.meta.title?.trim()) return;
    const title = sessionPreview(text);
    if (title) this.updateMeta({ title });
  }

  setHarnessTarget(harnessTargetId: string, target: HarnessTargetMeta): void {
    if (target.harnessTargetId !== harnessTargetId) {
      throw new Error(
        `harness target key mismatch: key=${harnessTargetId}, meta=${target.harnessTargetId}`,
      );
    }
    this.meta.harnessTargets = {
      ...this.meta.harnessTargets,
      [harnessTargetId]: target,
    };
    this.meta = normalizeSessionMeta(this.meta);
    writeMetaAtomic(this.dir, this.meta);
  }

  setLane(laneId: string, lane: LaneMeta): void {
    if (lane.laneId !== laneId) {
      throw new Error(
        `lane key mismatch: key=${laneId}, meta=${lane.laneId}`,
      );
    }
    this.meta.lanes = { ...this.meta.lanes, [laneId]: lane };
    this.meta = normalizeSessionMeta(this.meta);
    writeMetaAtomic(this.dir, this.meta);
  }

  setLaneHarnessSession(
    laneId: string,
    harnessTargetId: string,
    harnessSession: HarnessSessionMeta,
  ): void {
    const lane = this.meta.lanes[laneId];
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    this.setLane(laneId, {
      ...lane,
      harnessSessions: {
        ...lane.harnessSessions,
        [harnessTargetId]: harnessSession,
      },
    });
  }

  harnessSessionForTarget(harnessTargetId: string): HarnessSessionMeta | undefined {
    return this.meta.lanes[MAIN_LANE_ID]?.harnessSessions[harnessTargetId];
  }

  /** @deprecated Use Lane APIs; retained for embedders migrating old SessionMeta setup. */
  setHarnessSession(harnessTargetId: string, legacy: LegacyHarnessSessionMeta): void {
    if (legacy.harnessTargetId !== harnessTargetId) {
      throw new Error(
        `harness target key mismatch: key=${harnessTargetId}, meta=${legacy.harnessTargetId}`,
      );
    }
    const laneId = this.ensureMainLane().laneId;
    this.meta.harnessTargets = {
      ...this.meta.harnessTargets,
      [harnessTargetId]: {
        harnessTargetId,
        harness: legacy.harness,
        ...(legacy.model === undefined ? {} : { model: legacy.model }),
        ...(legacy.effort === undefined ? {} : { effort: legacy.effort }),
        ...(legacy.mode === undefined ? {} : { mode: legacy.mode }),
      },
    };
    this.setLaneHarnessSession(laneId, harnessTargetId, {
      harness: legacy.harness,
      ...(legacy.launchSnapshot === undefined
        ? {}
        : { launchSnapshot: legacy.launchSnapshot }),
      ...(legacy.harnessSessionId === undefined
        ? {}
        : { harnessSessionId: legacy.harnessSessionId }),
      ...(legacy.resumeState === undefined ? {} : { resumeState: legacy.resumeState }),
      ...(legacy.resumeCursor === undefined ? {} : { resumeCursor: legacy.resumeCursor }),
      ...(legacy.contextEpochId === undefined
        ? {}
        : { contextEpochId: legacy.contextEpochId }),
      ...(legacy.syncedSeq === undefined ? {} : { syncedSeq: legacy.syncedSeq }),
      ...(legacy.parentSessionId === undefined
        ? {}
        : { parentSessionId: legacy.parentSessionId }),
    });
  }

  ensureMainLane(): LaneMeta {
    const lane = this.meta.lanes[MAIN_LANE_ID];
    if (!lane) throw new Error(`main Lane not found: ${MAIN_LANE_ID}`);
    return lane;
  }

  requireLane(laneId: string): LaneMeta {
    const lane = this.meta.lanes[laneId];
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    return lane;
  }

  ensureHarnessInvocationLane(
    laneId: string,
    invocationId: string,
    parentLaneId: string,
  ): LaneMeta {
    this.requireLane(parentLaneId);
    const existing = this.meta.lanes[laneId];
    if (existing) {
      if (
        existing.createdFor.type !== "harness_invocation" ||
        existing.createdFor.invocationId !== invocationId ||
        existing.parentLaneId !== parentLaneId
      ) {
        throw new Error(`Lane identity conflict: ${laneId}`);
      }
      return existing;
    }
    const lane = createLaneMeta({
      laneId,
      createdFor: { type: "harness_invocation", invocationId },
      parentLaneId,
    });
    this.setLane(laneId, lane);
    return lane;
  }

  /**
   * 汇总一个 turn 并落盘 _baton_turn_summary 事件。
   * 幂等：同一 turnId 已有 summary 时直接返回已有的，不重复追加。
   */
  summarizeTurn(turnId: string): TurnSummary {
    return this.summarizeTurnEvent(turnId).payload;
  }

  /** 与 summarizeTurn 相同，但返回 envelope，供 live reducer 消费实际落盘事件。 */
  summarizeTurnEvent(turnId: string): EventEnvelope<"_baton_turn_summary"> {
    const events = this.ledger.read();
    const existing = events.find(
      (e): e is EventEnvelope<"_baton_turn_summary"> =>
        e.kind === "_baton_turn_summary" && e.payload.turnId === turnId,
    );
    if (existing) return existing;

    const turnEvents = events.filter((e) => e.turnId === turnId);
    if (turnEvents.length === 0) {
      throw new Error(`no events for turn ${turnId} in session ${this.id}`);
    }
    const state = reduceEvents(turnEvents);

    // 自动注入块保留在原始事件里供审计，但不能进入摘要后再次被下一棒递归放大。
    const userText = stripBatonInjectedContext(joinMessages(state, "user"));
    const agentText = joinMessages(state, "agent");
    const toolCalls: TurnSummaryToolCall[] = [...state.toolCalls.values()].map((tc) => ({
      toolCallId: tc.toolCallId,
      title: tc.title,
      kind: tc.kind,
      status: tc.status,
    }));
    const usage: UsageUpdate | undefined =
      state.usage.inputTokens || state.usage.outputTokens
        ? {
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            cacheReadTokens: state.usage.cacheReadTokens,
            cacheWriteTokens: state.usage.cacheWriteTokens,
            reasoningTokens: state.usage.reasoningTokens,
            isEstimated: state.usage.hasEstimated,
          }
        : undefined;

    const summary: TurnSummary = {
      turnId,
      // per-turn 取值：输入虽已按 turnId 过滤，但显式按 turn 取让它对"过滤集混入
      // 他人终态"的任何未来变化免疫（无 turnId 的迟到终态只会进 lastStopReason）
      stopReason: (state.stopReasons.get(turnId) ?? state.lastStopReason) as StopReason | undefined,
      userText: userText || undefined,
      agentText: agentText || undefined,
      toolCalls,
      usage,
      startedAt: turnEvents[0]?.ts,
      endedAt: turnEvents[turnEvents.length - 1]?.ts,
    };
    const harness = turnEvents[0]?.harness ?? "baton";
    const harnessTargetId = turnEvents.find((event) => event.harnessTargetId)?.harnessTargetId;
    const laneId = turnEvents.find((event) => event.laneId)?.laneId;
    const event = this.appendEvent({
      kind: "_baton_turn_summary",
      source: { type: "baton" },
      payload: summary,
      harness,
      ...(harnessTargetId ? { harnessTargetId } : {}),
      ...(laneId ? { laneId } : {}),
      turnId,
    }) as EventEnvelope<"_baton_turn_summary">;
    this.updateMeta({ updatedAt: summary.endedAt ?? new Date().toISOString() });
    return event;
  }
}

const HISTORY_OPERATIONAL_KINDS = new Set<EventKind>([
  "_baton_turn_summary",
  "_baton_delivery_attempt_update",
  "_baton_context_snapshot",
  "_baton_context_delivery_receipt",
  "_baton_queue_reordered",
]);

function canonicalHistoryValue(value: unknown, key?: string): unknown {
  // Baton 和 Harness 各自签发的局部 ID、时间戳不属于历史语义；保留它们会让同一事实
  // 因承载坐标不同而误报 divergence。
  if (key && (/Id$/.test(key) || key === "ts" || key.endsWith("At"))) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalHistoryValue(item));
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalized = canonicalHistoryValue(entryValue, entryKey);
    if (normalized !== undefined) out[entryKey] = normalized;
  }
  return out;
}

function historyTurnProjection(turn: HarnessHistoryTurn): unknown {
  return {
    userText: comparableTurnText(turn.userText) || undefined,
    agentText: comparableTurnText(turn.agentText) || undefined,
    events: turn.events?.map(({ source, event }) => ({
      source,
      kind: event.kind,
      payload: canonicalHistoryValue(event.payload),
    })),
  };
}

function harnessHistoryTurnDigest(turn: HarnessHistoryTurn): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalHistoryValue(historyTurnProjection(turn))))
    .digest("hex");
}

export function harnessHistoryBoundary(
  turns: readonly HarnessHistoryTurn[],
  throughCount = turns.length,
): HarnessHistoryBoundary {
  const prefix = turns.slice(0, throughCount);
  return {
    version: 1,
    turnId: prefix.at(-1)?.turnId,
    turnCount: prefix.length,
    prefixDigest: createHash("sha256")
      .update(JSON.stringify(prefix.map(historyTurnProjection)))
      .digest("hex"),
  };
}

function assertObservedBoundary(source: HarnessSessionAdoptionSource): void {
  const calculated = harnessHistoryBoundary(source.turns);
  if (
    calculated.version !== source.observedThrough.version ||
    calculated.turnCount !== source.observedThrough.turnCount ||
    calculated.turnId !== source.observedThrough.turnId ||
    calculated.prefixDigest !== source.observedThrough.prefixDigest
  ) {
    throw new Error(
      `invalid HarnessHistoryBoundary for ` +
        `${source.session.harnessTargetId}/${source.session.identity.id}`,
    );
  }
}

function adoptionFor(meta: SessionMeta): HarnessSessionAdoption | undefined {
  if (meta.adoptedFrom) return meta.adoptedFrom;
  if (!meta.nativeSessionOrigin) return undefined;
  return {
    session: {
      harnessTargetId: meta.nativeSessionOrigin.harnessTargetId,
      harness: meta.nativeSessionOrigin.harness,
      identity: { id: meta.nativeSessionOrigin.nativeSessionId },
    },
    // 旧 meta 没保存内容边界；首次刷新仍会和已落盘的完整 turn 做逐轮对账，成功后升级。
    importedThrough: harnessHistoryBoundary([]),
  };
}

function materializedHistoryTurns(
  session: SessionHandle,
  summaries: readonly EventEnvelope<"_baton_turn_summary">[],
): HarnessHistoryTurn[] {
  const events = session.ledger.read();
  // 新事件流里 steer 的投递事实在 input_delivery_update；未证应用的 steer 内容不进历史。
  const appliedSteers = new Set<string>();
  for (const event of events) {
    if (event.kind === "input_delivery_update" && event.payload.state === "applied") {
      appliedSteers.add(event.payload.messageId);
    }
  }
  return summaries.map((summary) => ({
    turnId: summary.turnId,
    userText: summary.payload.userText,
    agentText: summary.payload.agentText,
    events: events.flatMap((event): HarnessHistoryEvent[] => {
      if (
        event.turnId !== summary.turnId ||
        event.seq >= summary.seq ||
        HISTORY_OPERATIONAL_KINDS.has(event.kind) ||
        (event.kind === "user_message" &&
          event.payload.delivery === "steer" &&
          (event.payload.deliveryState !== undefined
            ? // Legacy 补丁语义不变：状态补丁事件本身不进历史，applied 补丁进。
              event.payload.deliveryState !== "applied"
            : !appliedSteers.has(event.payload.messageId)))
      ) {
        return [];
      }
      const source =
        event.source.type === "user"
          ? "user"
          : event.source.type === "harness"
            ? "harness"
            : "baton";
      return [{
        source,
        event: {
          kind: event.kind,
          payload: event.payload,
        } as AnyEventDraft,
      }];
    }),
  }));
}

/** kill(pid, 0) 探活：EPERM 表示进程存在但无权限发信号，同样算活。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function joinMessages(state: SessionState, role: "user" | "agent"): string {
  const parts: string[] = [];
  for (const item of state.timeline) {
    if (item.type !== "message") continue;
    const msg = state.messages.get(item.id);
    if (msg && msg.role === role) {
      if (role === "user" && msg.delivery === "steer") {
        // 投递事实以 input 投影为准：有 input 记录时 outcome 未填写即未应用；
        // 没有 input 记录的老 ledger 才回落 user_message.deliveryState。
        const input = state.harnessInputs.get(msg.messageId);
        if (input) {
          if (input.deliveryOutcome !== "applied") continue;
        } else if (msg.deliveryState !== undefined && msg.deliveryState !== "applied") {
          continue;
        }
      }
      const text = textOf(msg.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function materializedEventSource(
  source: HarnessHistoryEvent["source"],
  harnessTargetId: string,
): EventSource {
  switch (source) {
    case "user":
      return { type: "user" };
    case "baton":
      return { type: "baton" };
    case "harness":
      return { type: "harness", harnessTargetId };
  }
}

function comparableTurnText(text: string | undefined): string {
  return text?.replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim() ?? "";
}

function stripBatonInjectedContext(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*?<\/baton-\1>\s*/g, "").trim();
}
