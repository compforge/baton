import type {
  BoardPresentation,
  BoardItemTone,
  Resource,
  ResourceType,
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
  readonly resourceType: ResourceType;
  readonly list: () => readonly Readonly<Resource<TSpec, TStatus>>[];
  readonly present: (
    resource: Readonly<Resource<TSpec, TStatus>>,
  ) => Promise<BoardPresentation | undefined>;
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
      source.resourceType.apiVersion,
      source.resourceType.kind,
      resourceId,
    ]),
    pluginId: source.pluginId,
    pluginInstanceId: source.pluginInstanceId,
    resourceKind: source.resourceType.kind,
    resourceId,
    title: presentation.title,
    ...(presentation.status === undefined ? {} : { status: presentation.status }),
    ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
    ...(presentation.tone === undefined ? {} : { tone: presentation.tone }),
  });
}

/** 单个 Resource 的展示失败只生成一条诊断项，不遮掉其它 Plugin 的 Board。 */
export async function presentBoardSource<TSpec, TStatus>(
  source: BoardSource<TSpec, TStatus>,
): Promise<readonly BoardItem[]> {
  const items: BoardItem[] = [];
  for (const resource of source.list()) {
    if (resource.metadata.deletionTimestamp !== undefined) continue;
    try {
      const presentation = await source.present(resource);
      if (presentation) {
        items.push(
          presentResource(source, resource.metadata.name, presentation),
        );
      }
    } catch (error) {
      const resourceId = resource.metadata.name;
      items.push(
        Object.freeze({
          id: JSON.stringify([
            source.pluginInstanceId,
            source.resourceType.apiVersion,
            source.resourceType.kind,
            resourceId,
          ]),
          pluginId: source.pluginId,
          pluginInstanceId: source.pluginInstanceId,
          resourceKind: source.resourceType.kind,
          resourceId,
          title: `${source.resourceType.kind}/${resourceId}`,
          status: "presentation failed",
          detail: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      );
    }
  }
  return Object.freeze(items);
}
