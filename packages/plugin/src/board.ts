export type BoardItemTone =
  | "default"
  | "muted"
  | "success"
  | "warning"
  | "error";

/** Plugin 对一份 Resource 的 Board 展示内容；身份与归属由 Baton 补齐。 */
export interface BoardPresentation {
  readonly title: string;
  readonly status?: string;
  readonly detail?: string;
  readonly tone?: BoardItemTone;
}
