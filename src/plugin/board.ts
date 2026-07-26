import type {
  BoardPresentation,
  BoardItemTone,
  Resource,
} from "./package.ts";

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
  readonly list: () => readonly Readonly<Resource<TSpec, TStatus>>[];
  readonly present: (
    resource: Readonly<Resource<TSpec, TStatus>>,
  ) => BoardPresentation | undefined;
}

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function presentResource<TSpec, TStatus>(
  source: BoardSource<TSpec, TStatus>,
  resourceId: string,
  presentation: BoardPresentation,
): BoardItem {
  nonEmpty("Board item title", presentation.title);
  return Object.freeze({
    id: JSON.stringify([
      source.pluginInstanceId,
      source.resourceKind,
      resourceId,
    ]),
    pluginId: source.pluginId,
    pluginInstanceId: source.pluginInstanceId,
    resourceKind: source.resourceKind,
    resourceId,
    title: presentation.title,
    ...(presentation.status === undefined ? {} : { status: presentation.status }),
    ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
    ...(presentation.tone === undefined ? {} : { tone: presentation.tone }),
  });
}

/** 单个 Resource 的展示失败只生成一条诊断项，不遮掉其它 Plugin 的 Board。 */
export function presentBoardSource<TSpec, TStatus>(
  source: BoardSource<TSpec, TStatus>,
): readonly BoardItem[] {
  const items: BoardItem[] = [];
  for (const resource of source.list()) {
    try {
      const presentation = source.present(resource);
      if (presentation) {
        items.push(
          presentResource(source, resource.metadata.resourceId, presentation),
        );
      }
    } catch (error) {
      const resourceId = resource.metadata.resourceId;
      items.push(
        Object.freeze({
          id: JSON.stringify([
            source.pluginInstanceId,
            source.resourceKind,
            resourceId,
          ]),
          pluginId: source.pluginId,
          pluginInstanceId: source.pluginInstanceId,
          resourceKind: source.resourceKind,
          resourceId,
          title: `${source.resourceKind}/${resourceId}`,
          status: "presentation failed",
          detail: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      );
    }
  }
  return Object.freeze(items);
}
