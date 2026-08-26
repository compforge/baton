import type { LogLevel } from "../logging.ts";

/** 一份 HarnessTarget 的用户配置；`harness` 选择解析它的 HarnessDefinition。 */
export interface HarnessTargetConfig {
  readonly harness: string;
  readonly [key: string]: unknown;
}

export interface NotificationConfig {
  /** turn 完成 / 待决 Interaction 时发终端桌面通知（OSC 9 白名单终端）。 */
  enabled: boolean;
  /** OSC 9 不可用时是否退回 BEL 响铃；默认 false，不打扰。 */
  bell: boolean;
}

export interface BatonConfig {
  /** 打开 TUI / REPL 时默认选择的 HarnessTarget id。 */
  defaultTarget: string;
  /** HarnessTarget id → 该目标的 Harness 与启动配置。 */
  targets: Record<string, HarnessTargetConfig>;
  /** @ 引用与同会话 Harness 同步的摘要预算（字符）。 */
  mentionBudgetChars: number;
  /** 是否在时间线里显示 agent 的思考过程（reasoning 流）。 */
  showThoughts: boolean;
  /** TUI 桌面通知开关；`notifications: false` 整体关闭。 */
  notifications: NotificationConfig;
  /** session 标题旁路生成的首选 HarnessTarget id。 */
  textgenPrefer?: string;
  /** 各 HarnessTarget 的 textgen 模型覆盖；缺省由 Adapter 选择。 */
  textgenModels?: Record<string, string>;
  /** session.log 的最低记录级别。 */
  logLevel: LogLevel;
}
