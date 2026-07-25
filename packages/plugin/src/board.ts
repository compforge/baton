import type { PluginResource } from "./resource.ts";

export type BoardItemTone =
  | "default"
  | "muted"
  | "success"
  | "warning"
  | "error";

/**
 * Plugin 产出的 Board 条目草稿。key 只需在当前 Resource 内稳定且唯一；
 * 归属、Resource 身份和最终 item id 由 Baton 补齐。
 */
export interface BoardItemDraft {
  readonly key: string;
  readonly title: string;
  readonly status?: string;
  readonly detail?: string;
  readonly tone?: BoardItemTone;
}

/**
 * 从 PluginResource 派生 Board 读模型，不拥有或持久化新的业务事实。
 */
export interface BoardProjector<TSpec, TStatus> {
  project(
    resource: Readonly<PluginResource<TSpec, TStatus>>,
  ): readonly BoardItemDraft[];
}
