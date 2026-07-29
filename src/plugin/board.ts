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
  readonly resourceApiVersion: string;
  readonly resourceKind: string;
  readonly resourceShortName?: string;
  readonly resourceId: string;
  readonly title: string;
  readonly url?: string;
  readonly status?: string;
  readonly detail?: string;
  readonly tone?: BoardItemTone;
}

export interface BoardItemCandidate {
  readonly item: BoardItem;
  readonly groupId: string;
  readonly priority: number;
  readonly creationTimestamp: string;
}

const MAX_ITEMS_PER_RESOURCE_TYPE = 5;

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
  resource: Readonly<Resource<TSpec, TStatus>>,
  presentation: BoardPresentation,
): BoardItemCandidate {
  nonEmpty("Board item title", presentation.title);
  const priority = presentation.priority ?? 0;
  if (!Number.isFinite(priority)) {
    throw new Error("Board item priority must be finite");
  }
  const resourceId = resource.metadata.name;
  return Object.freeze({
    item: Object.freeze({
      id: JSON.stringify([
        source.pluginInstanceId,
        source.resourceType.apiVersion,
        source.resourceType.kind,
        resourceId,
      ]),
      pluginId: source.pluginId,
      pluginInstanceId: source.pluginInstanceId,
      resourceApiVersion: source.resourceType.apiVersion,
      resourceKind: source.resourceType.kind,
      ...(source.resourceType.shortNames?.[0] === undefined
        ? {}
        : { resourceShortName: source.resourceType.shortNames[0] }),
      resourceId,
      title: presentation.title,
      ...(presentation.url === undefined ? {} : { url: presentation.url }),
      ...(presentation.status === undefined ? {} : { status: presentation.status }),
      ...(presentation.detail === undefined ? {} : { detail: presentation.detail }),
      ...(presentation.tone === undefined ? {} : { tone: presentation.tone }),
    }),
    groupId: JSON.stringify([
      source.pluginInstanceId,
      source.resourceType.apiVersion,
      source.resourceType.kind,
    ]),
    priority,
    creationTimestamp: resource.metadata.creationTimestamp,
  });
}

/** 单个 Resource 的展示失败只生成一条诊断项，不遮掉其它 Plugin 的 Board。 */
export async function presentBoardSource<TSpec, TStatus>(
  source: BoardSource<TSpec, TStatus>,
): Promise<readonly BoardItemCandidate[]> {
  const items: BoardItemCandidate[] = [];
  for (const resource of source.list()) {
    if (resource.metadata.deletionTimestamp !== undefined) continue;
    try {
      const presentation = await source.present(resource);
      if (presentation) {
        items.push(
          presentResource(source, resource, presentation),
        );
      }
    } catch (error) {
      const resourceId = resource.metadata.name;
      items.push(
        Object.freeze({
          item: Object.freeze({
            id: JSON.stringify([
              source.pluginInstanceId,
              source.resourceType.apiVersion,
              source.resourceType.kind,
              resourceId,
            ]),
            pluginId: source.pluginId,
            pluginInstanceId: source.pluginInstanceId,
            resourceApiVersion: source.resourceType.apiVersion,
            resourceKind: source.resourceType.kind,
            ...(source.resourceType.shortNames?.[0] === undefined
              ? {}
              : { resourceShortName: source.resourceType.shortNames[0] }),
            resourceId,
            title: `${source.resourceType.kind}/${resourceId}`,
            status: "presentation failed",
            detail: error instanceof Error ? error.message : String(error),
            tone: "error",
          }),
          groupId: JSON.stringify([
            source.pluginInstanceId,
            source.resourceType.apiVersion,
            source.resourceType.kind,
          ]),
          priority: 0,
          creationTimestamp: resource.metadata.creationTimestamp,
        }),
      );
    }
  }
  return Object.freeze(items);
}

function compareCandidates(
  left: BoardItemCandidate,
  right: BoardItemCandidate,
): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  const byCreation = right.creationTimestamp.localeCompare(left.creationTimestamp);
  if (byCreation !== 0) return byCreation;
  return left.item.id.localeCompare(right.item.id);
}

/** Baton 按 PluginInstance + Resource Type 分配 Board 容量；Plugin 只提供条目优先级。 */
export function selectBoardItems(
  candidates: readonly BoardItemCandidate[],
): readonly BoardItem[] {
  const byResourceType = new Map<string, BoardItemCandidate[]>();
  for (const candidate of candidates) {
    const group = byResourceType.get(candidate.groupId);
    if (group) group.push(candidate);
    else byResourceType.set(candidate.groupId, [candidate]);
  }

  const selected: BoardItem[] = [];
  for (const group of byResourceType.values()) {
    const ranked = [...group].sort(compareCandidates);
    for (const candidate of ranked.slice(0, MAX_ITEMS_PER_RESOURCE_TYPE)) {
      selected.push(candidate.item);
    }
  }
  return Object.freeze(selected);
}
