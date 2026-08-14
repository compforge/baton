// ~/.baton/config.yaml：用户级配置。优先级 env > config.yaml > 默认值。
// 首次运行自动生成默认文件，用户直接编辑即可。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import { parseHarness, type HarnessName } from "../harness/ids.ts";
import type { LogLevel } from "../logging.ts";

export interface BatonConfig {
  /** 打开 TUI / REPL 时的默认 agent（canonical harness id） */
  defaultAgent: HarnessName;
  /** claude 可执行文件路径（如公司包装器 reclaude）；env BATON_CLAUDE_BIN 优先 */
  claudeExecutable?: string;
  /** codex 启动命令（headless 必须是 app-server 形态） */
  codexCommand: string[];
  /** DeepSeek Harness JSON-RPC runtime 完整启动 argv（含 Cordis 配置路径） */
  dshCommand?: string[];
  /** DSH SDK 创建 agent 时使用的 provider / model；缺省跟随 SDK runtime 默认值。 */
  dshProvider?: string;
  dshModel?: string;
  /**
   * codex 审批人（approvals_reviewer）。**缺省不设 = 跟随 codex 自己的解析**
   * （~/.codex/config.toml、profile、企业 requirements 照常生效，codex 自身默认是 user）。
   * 显式设了才作为 thread/start 参数下发，是一次 opt-in 覆盖。
   * baton 不替 codex 定审批的安全默认。见 docs/approval-lifecycle.md。
   */
  codexApprovalReviewer?: "user" | "auto_review";
  /** @ 引用与同会话 harness 同步的摘要预算（字符） */
  mentionBudgetChars: number;
  /** 是否在时间线里显示 agent 的思考过程（reasoning 流） */
  showThoughts: boolean;
  /**
   * textgen 旁路生成（session 标题）的首选 harness（canonical id）。缺省 =
   * 当前 turn 的 harness 优先，失败再降级其他家。
   * 某家 quota 不可用时可在此显式换边。
   */
  textgenPrefer?: HarnessName;
  /** 各 harness 的 textgen 模型覆盖（key = canonical harness id）；缺省由 adapter 选择。 */
  textgenModels?: Record<string, string>;
  /** session.log 的最低记录级别。 */
  logLevel: LogLevel;
}

// codexApprovalReviewer 有意不列：缺省就是"不下发、跟随 codex"。
export const DEFAULT_CONFIG: BatonConfig = {
  defaultAgent: "codex",
  codexCommand: ["codex", "app-server"],
  dshModel: "prod",
  mentionBudgetChars: 4096,
  showThoughts: true,
  logLevel: "info",
};

export function batonRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".baton");
}

export function configPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "config.yaml");
}

/** 不存在则写入默认配置，返回文件路径。只在入口调用一次，load 本身无副作用。 */
export function ensureConfigFile(rootDir?: string): string {
  const path = configPath(rootDir);
  if (!existsSync(path)) {
    mkdirSync(batonRoot(rootDir), { recursive: true });
    writeFileSync(path, stringify(DEFAULT_CONFIG));
  }
  return path;
}

export function loadConfig(rootDir?: string): BatonConfig {
  let fromFile: Partial<BatonConfig> = {};
  const path = configPath(rootDir);
  if (existsSync(path)) {
    try {
      fromFile = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<BatonConfig>;
    } catch {
      fromFile = {};
    }
  }
  const merged: BatonConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    codexCommand:
      Array.isArray(fromFile.codexCommand) && fromFile.codexCommand.length > 0
        ? fromFile.codexCommand
        : DEFAULT_CONFIG.codexCommand,
  };
  if (
    !Array.isArray(merged.dshCommand) ||
    merged.dshCommand.length === 0 ||
    merged.dshCommand.some((part) => typeof part !== "string" || !part.trim())
  ) {
    merged.dshCommand = undefined;
  }
  if (typeof merged.dshProvider !== "string" || !merged.dshProvider.trim()) {
    merged.dshProvider = undefined;
  }
  if (typeof merged.dshModel !== "string" || !merged.dshModel.trim()) {
    merged.dshModel = DEFAULT_CONFIG.dshModel;
  }
  merged.defaultAgent =
    typeof merged.defaultAgent === "string"
      ? (parseHarness(merged.defaultAgent) ?? DEFAULT_CONFIG.defaultAgent)
      : DEFAULT_CONFIG.defaultAgent;
  if (!Number.isFinite(merged.mentionBudgetChars) || merged.mentionBudgetChars <= 0) {
    merged.mentionBudgetChars = DEFAULT_CONFIG.mentionBudgetChars;
  }
  if (typeof merged.showThoughts !== "boolean") {
    merged.showThoughts = DEFAULT_CONFIG.showThoughts;
  }
  if (!["debug", "info", "warn", "error"].includes(merged.logLevel)) {
    merged.logLevel = DEFAULT_CONFIG.logLevel;
  }
  // 只接受已知取值；其余（含缺省）落回 undefined = 不下发、跟随 codex 自己的解析。
  // 这里**不推导生效值**：曾经为了让 footer 准确，config 复刻了一遍 codex 的方言解析，
  // 但那必然算错——企业 requirements 能覆盖用户配置和启动参数。生效值只由 codex 回吐，
  // 见 CodexAdapter.approvalRoute。
  if (merged.codexApprovalReviewer !== "auto_review" && merged.codexApprovalReviewer !== "user") {
    merged.codexApprovalReviewer = undefined;
  }
  // 与 defaultAgent 同规则：只接受已知 harness；未知值视为未配置（跟随默认降级链）。
  merged.textgenPrefer =
    typeof merged.textgenPrefer === "string"
      ? (parseHarness(merged.textgenPrefer) ?? undefined)
      : undefined;
  if (
    merged.textgenModels !== undefined &&
    (typeof merged.textgenModels !== "object" ||
      merged.textgenModels === null ||
      Array.isArray(merged.textgenModels) ||
      Object.values(merged.textgenModels).some((v) => typeof v !== "string" || !v.trim()))
  ) {
    merged.textgenModels = undefined;
  }
  if (process.env.BATON_CLAUDE_BIN) merged.claudeExecutable = process.env.BATON_CLAUDE_BIN;
  return merged;
}
