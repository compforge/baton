export type BoardItemTone =
  | "default"
  | "muted"
  | "success"
  | "warning"
  | "error";

/** Plugin 对一份 Resource 的 Board 展示；返回 undefined 即不展示。 */
export interface ResourcePrint {
  readonly title: string;
  readonly status?: string;
  readonly detail?: string;
  readonly tone?: BoardItemTone;
}
