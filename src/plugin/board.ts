import type {
  BoardItemDraft,
  BoardItemTone,
  BoardProjector,
} from "./package.ts";
import type { PluginResourceStore } from "./resource.ts";

export interface BoardItem {
  readonly id: string;
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly resourceKind: string;
  readonly resourceId: string;
  readonly title: string;
  readonly status?: string;
  readonly detail?: string;
  readonly tone?: BoardItemTone;
}

export interface BoardSource<TSpec = unknown, TStatus = unknown> {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly resourceKind: string;
  readonly store: PluginResourceStore;
  readonly projector: BoardProjector<TSpec, TStatus>;
}

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function projectDraft(
  source: BoardSource,
  resourceId: string,
  draft: BoardItemDraft,
): BoardItem {
  nonEmpty("Board item key", draft.key);
  nonEmpty("Board item title", draft.title);
  return Object.freeze({
    id: JSON.stringify([
      source.pluginInstanceId,
      source.resourceKind,
      resourceId,
      draft.key,
    ]),
    pluginId: source.pluginId,
    pluginInstanceId: source.pluginInstanceId,
    resourceKind: source.resourceKind,
    resourceId,
    title: draft.title,
    ...(draft.status === undefined ? {} : { status: draft.status }),
    ...(draft.detail === undefined ? {} : { detail: draft.detail }),
    ...(draft.tone === undefined ? {} : { tone: draft.tone }),
  });
}

/** 单个 Projection 的失败只生成一条诊断项，不遮掉其它 Plugin 的 Board。 */
export function projectBoardSource(source: BoardSource): readonly BoardItem[] {
  const items: BoardItem[] = [];
  for (const resource of source.store.list(source.resourceKind)) {
    try {
      const drafts = source.projector.project(resource);
      const keys = new Set<string>();
      const resourceItems: BoardItem[] = [];
      for (const draft of drafts) {
        if (keys.has(draft.key)) {
          throw new Error(`duplicate Board item key: ${draft.key}`);
        }
        keys.add(draft.key);
        resourceItems.push(
          projectDraft(source, resource.metadata.resourceId, draft),
        );
      }
      items.push(...resourceItems);
    } catch (error) {
      const resourceId = resource.metadata.resourceId;
      items.push(
        Object.freeze({
          id: JSON.stringify([
            source.pluginInstanceId,
            source.resourceKind,
            resourceId,
            "__projection_error",
          ]),
          pluginId: source.pluginId,
          pluginInstanceId: source.pluginInstanceId,
          resourceKind: source.resourceKind,
          resourceId,
          title: `${source.resourceKind}/${resourceId}`,
          status: "projection failed",
          detail: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      );
    }
  }
  return Object.freeze(items);
}
