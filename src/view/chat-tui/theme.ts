// baton 的 TUI 配色：在 chat-tui defaultTheme 之上按 author 区分 agent 消息颜色。
// harness 语义归 harness（chat-tui 的边界约定），所以映射放这里而不是 chat-tui。

import { defaultTheme, type Theme } from "chat-tui";

import { HARNESS_REGISTRY } from "../harness/registry.ts";

/**
 * 已知 harness 的固定认色，从 registry 派生（shortName 即 author 展示名 =
 * 着色 key，单一来源，不再靠注释约定两处一致）。取色约束见 HarnessDefinition.color
 * 的注释：避开 user 蓝 / error 红 / success 绿。
 */
const DARK_HARNESS_COLORS: Record<string, string> = Object.fromEntries(
  HARNESS_REGISTRY.map((definition) => [definition.shortName, definition.color]),
);

/** 同一身份色在浅色背景上的高对比度版本；色相不变，避免切主题后认色关系漂移。 */
const LIGHT_HARNESS_COLORS: Record<string, string> = {
  codex: "#0f766e",
  claude: "#9a3412",
};

/**
 * 未知 harness 的兜底池：harness 是开放扩展点，新 harness 按名字哈希
 * 拿稳定颜色，而不是全部跌回同一个默认紫。
 */
const FALLBACK_POOLS = {
  dark: ["#bb9af7", "#7dcfff", "#9ece6a", "#e0af68"],
  light: ["#6d28d9", "#0369a1", "#0e7a38", "#92660a"],
} as const;

export type BatonThemeMode = "dark" | "light";

export function agentColorFor(author: string, mode: BatonThemeMode = "dark"): string {
  const named = (mode === "light" ? LIGHT_HARNESS_COLORS : DARK_HARNESS_COLORS)[author];
  if (named) return named;
  const pool = FALLBACK_POOLS[mode];
  let hash = 0;
  for (const ch of author) hash = (hash + ch.charCodeAt(0)) % pool.length;
  return pool[hash] as string;
}

const LIGHT_THEME: Theme = {
  dim: "#5f5f5f",
  runStatus: "#6d28d9",
  user: "#9a4a00",
  agent: "#6d28d9",
  tool: "#1a1a1a",
  plan: "#0369a1",
  success: "#0e7a38",
  error: "#b91c1c",
  warning: "#92660a",
  accent: "#1565c0",
  border: "#737373",
  borderActive: "#92660a",
  overlayBackground: "#ffffff",
  diffAddedBg: "#e8f5e9",
  diffRemovedBg: "#ffebee",
};

/**
 * 终端背景 → dark/light。palette 返回标准 #RRGGBB；无法识别时交给 OpenTUI 的
 * themeMode 兜底，不在这里猜环境变量或终端品牌。
 */
export function themeModeForBackground(background: string | null | undefined): BatonThemeMode | null {
  const match = background?.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  const [r, g, b] = match.slice(1).map((channel) => Number.parseInt(channel as string, 16));
  const brightness = ((r as number) * 299 + (g as number) * 587 + (b as number) * 114) / 1000;
  return brightness > 128 ? "light" : "dark";
}

/** 根据终端模式构造 Baton 主题；探测到的真实背景同时用于不透明浮层。 */
export function batonThemeFor(
  mode: BatonThemeMode,
  terminalBackground?: string | null,
): Theme {
  const base = mode === "light" ? LIGHT_THEME : defaultTheme;
  return {
    ...base,
    ...(terminalBackground ? { overlayBackground: terminalBackground } : {}),
    agentColorFor: (author) => agentColorFor(author, mode),
  };
}

/** 非 TTY/测试等没有探测结果时的兼容默认。 */
export const batonTheme: Theme = batonThemeFor("dark");
