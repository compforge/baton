// 终端桌面通知（OSC 9）的纯逻辑：能力检测、文案消毒、序列构造。
// 参考 kimi-code 的 terminal-notification；差异：不支持的终端默认静默，
// BEL 只在配置显式开启时使用。

import type { AnyEventEnvelope } from "../../event/index.ts";
import type { Interaction } from "../../interaction/types.ts";

const ESC = "\x1b";
const BEL = "\x07";
const ST = "\\";

/** 单条通知消毒后的最大长度（码点）。 */
export const MAX_NOTIFICATION_MESSAGE_LENGTH = 120;

export interface NotificationConfig {
  /** 桌面通知总开关；不支持的终端始终静默。 */
  enabled: boolean;
  /** OSC 9 不可用时是否退回 BEL 响铃；默认 false，不打扰。 */
  bell: boolean;
}

/** OSC 9 桌面通知能力白名单：只认明确表示支持的终端，其余一律静默。 */
export function supportsOsc9Notification(env: NodeJS.ProcessEnv = process.env): boolean {
  const termProgram = env["TERM_PROGRAM"] ?? "";
  if (
    termProgram === "iTerm.app" ||
    termProgram === "WezTerm" ||
    termProgram === "ghostty" ||
    termProgram === "WarpTerminal"
  ) {
    return true;
  }
  const term = env["TERM"] ?? "";
  return term === "xterm-kitty" || term === "xterm-ghostty";
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["TMUX"] ?? "").length > 0;
}

function isControlCharacter(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x00 && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f) ||
    // bidi 控制与方向标记：防止通知文案重排终端显示
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f
  );
}

/** 剥控制字符 / bidi 标记、折叠空白、截断，得到单行安全的通知文案。 */
export function sanitizeNotificationText(value: string): string {
  const cleaned = Array.from(value)
    .map((ch) => (isControlCharacter(ch) ? " " : ch))
    .join("")
    .replaceAll(/\s+/g, " ")
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > MAX_NOTIFICATION_MESSAGE_LENGTH
    ? `${chars.slice(0, MAX_NOTIFICATION_MESSAGE_LENGTH - 1).join("")}…`
    : cleaned;
}

export interface NotificationSequenceOptions {
  osc9: boolean;
  tmux: boolean;
  bell: boolean;
}

/**
 * 构造通知序列：
 * - osc9 可用 → OSC 9（tmux 下 DCS 透传，内层 ESC 加倍）；
 * - 不可用且显式开启 bell → 裸 BEL；
 * - 否则静默（空数组）。
 */
export function buildNotificationSequences(
  message: string,
  options: NotificationSequenceOptions,
): string[] {
  const text = sanitizeNotificationText(message);
  if (text.length === 0) return [];
  if (options.osc9) {
    const osc9 = `${ESC}]9;${text}${BEL}`;
    if (options.tmux) {
      const escaped = osc9.replaceAll(ESC, `${ESC}${ESC}`);
      return [`${ESC}Ptmux;${escaped}${ESC}${ST}`];
    }
    return [osc9];
  }
  return options.bell ? [BEL] : [];
}

/** 需要人处理的 blocking Interaction；suggested_input 不打断用户，不通知。 */
function interactionNotificationTitle(interaction: Interaction): string | null {
  switch (interaction.kind) {
    case "permission":
    case "harness_invocation":
      return interaction.title;
    case "question": {
      const first = interaction.questions[0];
      return first ? (first.header || first.question) : "question";
    }
    case "hook_trust":
      return `Trust ${interaction.hooks.length} ${interaction.harnessName} hook${interaction.hooks.length === 1 ? "" : "s"}?`;
    default:
      return null;
  }
}

export interface TerminalNotifierOptions {
  config: NotificationConfig;
  /** 会话显示标题，用于 turn finished 文案。 */
  sessionTitle: () => string;
  env?: NodeJS.ProcessEnv;
  write?: (sequence: string) => void;
}

/**
 * TUI 进程侧的桌面通知器：观察 live Event，turn 收口与 blocking Interaction
 * 出现时发一条通知。不写任何持久状态。
 */
export class TerminalNotifier {
  constructor(private readonly options: TerminalNotifierOptions) {}

  handleEvent(event: AnyEventEnvelope): void {
    if (!this.options.config.enabled) return;
    if (event.kind === "_baton_turn_summary") {
      // 用户自己 Esc 取消的 turn 不通知——人就在终端前。
      if (event.payload.stopReason === "cancelled") return;
      this.emit(`baton: turn finished · ${this.options.sessionTitle()}`);
      return;
    }
    if (event.kind === "interaction.requested") {
      const title = interactionNotificationTitle(event.payload);
      if (title) this.emit(`baton: needs your input · ${title}`);
    }
  }

  private emit(message: string): void {
    const env = this.options.env ?? process.env;
    const sequences = buildNotificationSequences(message, {
      osc9: supportsOsc9Notification(env),
      tmux: isInsideTmux(env),
      bell: this.options.config.bell,
    });
    const write = this.options.write ?? ((sequence: string) => process.stdout.write(sequence));
    for (const sequence of sequences) write(sequence);
  }
}
