export type BoardItemTone =
  | "default"
  | "muted"
  | "success"
  | "warning"
  | "error";

/** Plugin 对一份 Resource 的 Board 展示内容；身份与归属由 Baton 补齐。 */
export interface BoardPresentation {
  readonly title: string;
  /** Optional terminal-native hyperlink for this Board item. */
  readonly url?: string;
  readonly status?: string;
  readonly detail?: string;
  readonly tone?: BoardItemTone;
  /** Higher values are shown first within the same Plugin instance and Resource type. */
  readonly priority?: number;
}
