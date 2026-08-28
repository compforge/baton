// harness 运行时定义的唯一权威：轻量身份（id + aliases）来自 ids.ts，
// wire/持久化 key、展示名、认色和 adapter 工厂在这里组装成 HarnessDefinition。
// 任何按名字分发、贴标签、着色的代码都必须经本模块归一。

import type { HarnessAdapter, OpenInteraction, NativeEventSink } from "./adapter.ts";
import { ClaudeAdapter, probeClaudeTarget } from "./claude/adapter.ts";
import { resolveClaudeTargetConfig } from "./claude/config.ts";
import { claudeSessionInspector } from "./claude/native-session.ts";
import { CodexAdapter } from "./codex/adapter.ts";
import { resolveCodexTargetConfig } from "./codex/config.ts";
import { codexSessionInspector } from "./codex/native-session.ts";
import { DshAdapter } from "./dsh/adapter.ts";
import { resolveDshTargetConfig } from "./dsh/config.ts";
import {
  targetEnvironmentFor,
  type BatonConfig,
  type HarnessTargetConfig,
} from "../config/config.ts";
import { FileHookTrustStore } from "../config/hook.ts";
import type { LogSink } from "../logging.ts";
import { HARNESS_IDENTITIES, HARNESSES, parseHarness, type HarnessName } from "./ids.ts";
import type { HarnessSessionInspector } from "./native-session.ts";
import type { HarnessTarget, HarnessTargetProbeResult } from "./target.ts";

export { HARNESSES, parseHarness, type HarnessName };

export interface HarnessAdapterOptions {
  /** Adapter 工厂的实例坐标；工厂负责把 Target 配置 lowering 成具体 Adapter 依赖。 */
  target: HarnessTarget;
  openInteraction: OpenInteraction;
  log?: LogSink;
  nativeEvent?: NativeEventSink;
  targetConfig: HarnessTargetConfig;
  /** 已校验的 Target 固定环境；覆盖每次 open 动态传入的同名变量。 */
  env?: Readonly<Record<string, string>>;
  rootDir?: string;
}

export interface HarnessDefinition<Id extends string = string> {
  /** canonical id：用户侧词汇（slash command、Target 的 harness 字段） */
  id: Id;
  /** 用户侧简写；输入时归一到 id，不进入事件或持久化 */
  aliases: readonly string[];
  /** picker / 帮助文案里的展示长名 */
  label: string;
  /**
   * wire key：事件 harness 字段与 HarnessSessionMeta.harness。
   * **冻结值，永不变更**——session.jsonl 用它；HarnessSessionMeta 则按 harnessTargetId
   * 索引，使同一种 Harness 的多个 target 不会共享原生 session。
   */
  sessionKey: string;
  /** 时间线 author 短名，同时是着色 key（agentColorFor 的输入） */
  shortName: string;
  /** 固定认色：用户会形成"橙=claude"的肌肉记忆，颜色不随池子调整漂移 */
  color: string;
  create(options: HarnessAdapterOptions): HarnessAdapter;
  probe?: (options: HarnessProbeOptions) => Promise<HarnessTargetProbeResult>;
  /** Baton 外部 HarnessSession 的只读历史观察；不得启动或修改会话。 */
  sessionInspector?: HarnessSessionInspector;
}

export interface HarnessProbeOptions {
  target: HarnessTarget;
  cwd: string;
  env?: Record<string, string>;
  log?: LogSink;
  targetConfig: HarnessTargetConfig;
}

/** 首批内置 harness；扩展支持只在这里注册，不进入 BatonSession core。 */
export const HARNESS_REGISTRY = [
  {
    ...HARNESS_IDENTITIES.codex,
    label: "Codex",
    sessionKey: "codex",
    shortName: "codex",
    color: "#73daca", // 青
    sessionInspector: codexSessionInspector,
    create: ({ target, openInteraction, log, nativeEvent, targetConfig, env, rootDir }) => {
      const config = resolveCodexTargetConfig(targetConfig);
      return new CodexAdapter({
        openInteraction,
        log,
        nativeEvent,
        env,
        command: config.command,
        approvalReviewer: config.approvalReviewer,
        hookTrustStore: new FileHookTrustStore(target.id, rootDir),
      });
    },
  },
  {
    ...HARNESS_IDENTITIES.claude,
    label: "Claude Code",
    sessionKey: "claude-code",
    shortName: "claude",
    color: "#ff9e64", // 橙
    sessionInspector: claudeSessionInspector,
    create: ({ openInteraction, log, nativeEvent, targetConfig, env }) => {
      const config = resolveClaudeTargetConfig(targetConfig);
      return new ClaudeAdapter({
        openInteraction,
        log,
        nativeEvent,
        env,
        executablePath: config.executable,
      });
    },
    probe: ({ cwd, env, log, targetConfig }) => {
      const config = resolveClaudeTargetConfig(targetConfig);
      return probeClaudeTarget({
        cwd,
        env,
        log,
        executablePath: config.executable,
      });
    },
  },
  {
    ...HARNESS_IDENTITIES.dsh,
    label: "DeepSeek Harness",
    sessionKey: "deepseek-harness",
    shortName: "dsh",
    color: "#4d6bfe", // DeepSeek 蓝
    create: ({ log, nativeEvent, targetConfig, env }) => {
      const config = resolveDshTargetConfig(targetConfig);
      return new DshAdapter({
        log,
        nativeEvent,
        env,
        command: config.command,
        provider: config.provider,
        model: config.model,
      });
    },
  },
] as const satisfies readonly HarnessDefinition<HarnessName>[];

/**
 * 按 canonical id、alias **或** wire key 归一到 definition。
 * 未知输入返回 undefined（harness 是开放扩展点）。
 */
export function harnessDefinitionFor(idOrSessionKey: string): HarnessDefinition | undefined {
  const canonicalId = parseHarness(idOrSessionKey);
  return HARNESS_REGISTRY.find(
    (candidate) => candidate.id === canonicalId || candidate.sessionKey === idOrSessionKey,
  );
}

/** 配置中的 Target id 是唯一查找键；Harness 名只选择 Definition，不充当 Target identity。 */
export function resolveHarnessTarget(
  config: BatonConfig,
  harnessTargetId: string,
): HarnessTarget | undefined {
  const targetConfig = config.targets[harnessTargetId];
  if (!targetConfig) return undefined;
  const definition = harnessDefinitionFor(targetConfig.harness);
  return definition
    ? Object.freeze({ id: harnessTargetId, harness: definition.id })
    : undefined;
}

export function configuredHarnessTargets(config: BatonConfig): HarnessTarget[] {
  return Object.keys(config.targets).flatMap((targetId) => {
    const target = resolveHarnessTarget(config, targetId);
    return target ? [target] : [];
  });
}

/** CLI/TUI 选择：Target id 精确匹配优先，Harness id/alias 只选择该家的默认 Target。 */
export function resolveHarnessTargetSelection(
  config: BatonConfig,
  value: string,
): HarnessTarget | undefined {
  const exact = resolveHarnessTarget(config, value);
  if (exact) return exact;
  const harness = parseHarness(value);
  if (!harness) return undefined;
  const candidates = configuredHarnessTargets(config).filter((target) => target.harness === harness);
  return candidates.find((target) => target.id === harness) ?? (
    candidates.length === 1 ? candidates[0] : undefined
  );
}

/** 时间线 author / 着色 key；未知 harness 原样返回（开放扩展点的兜底展示） */
export function harnessShortName(idOrSessionKey: string): string {
  return harnessDefinitionFor(idOrSessionKey)?.shortName ?? idOrSessionKey;
}

export function createHarnessAdapter(
  target: HarnessTarget,
  options: Omit<HarnessAdapterOptions, "target">,
): HarnessAdapter {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === target.harness);
  if (!definition) {
    throw new Error(`HarnessTarget ${target.id} references an unregistered Harness: ${target.harness}`);
  }
  if (harnessDefinitionFor(options.targetConfig.harness)?.id !== target.harness) {
    throw new Error(
      `HarnessTarget config mismatch for ${target.id}: target=${target.harness}, config=${options.targetConfig.harness}`,
    );
  }
  const env = targetEnvironmentFor(options.targetConfig, target.id);
  return definition.create({
    ...options,
    target,
    ...(env ? { env } : {}),
  });
}

/** Target 级发现的唯一入口；没有 probe 的 Harness 返回空快照，不为发现而创建 Adapter。 */
export async function probeHarnessTarget(
  target: HarnessTarget,
  options: Omit<HarnessProbeOptions, "target">,
): Promise<HarnessTargetProbeResult> {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === target.harness);
  if (!definition) {
    throw new Error(`HarnessTarget ${target.id} references an unregistered Harness: ${target.harness}`);
  }
  if (harnessDefinitionFor(options.targetConfig.harness)?.id !== target.harness) {
    throw new Error(
      `HarnessTarget config mismatch for ${target.id}: target=${target.harness}, config=${options.targetConfig.harness}`,
    );
  }
  const targetEnv = targetEnvironmentFor(options.targetConfig, target.id);
  const env = options.env || targetEnv
    ? { ...options.env, ...targetEnv }
    : undefined;
  return "probe" in definition && definition.probe
    ? definition.probe({ ...options, target, ...(env ? { env } : {}) })
    : {};
}

export function harnessSessionKey(harness: HarnessName): string {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === harness);
  if (!definition) throw new Error(`Harness not registered: ${harness}`);
  return definition.sessionKey;
}
