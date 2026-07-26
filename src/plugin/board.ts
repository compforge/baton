import type {
  BoardItemTone,
  Resource,
  ResourcePrint,
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
  readonly print: (
    resource: Readonly<Resource<TSpec, TStatus>>,
  ) => ResourcePrint | undefined;
}

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function printResource<TSpec, TStatus>(
  source: BoardSource<TSpec, TStatus>,
  resourceId: string,
  printed: ResourcePrint,
): BoardItem {
  nonEmpty("Board item title", printed.title);
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
    title: printed.title,
    ...(printed.status === undefined ? {} : { status: printed.status }),
    ...(printed.detail === undefined ? {} : { detail: printed.detail }),
    ...(printed.tone === undefined ? {} : { tone: printed.tone }),
  });
}

/** 单个 Resource 的 print 失败只生成一条诊断项，不遮掉其它 Plugin 的 Board。 */
export function printBoardSource<TSpec, TStatus>(
  source: BoardSource<TSpec, TStatus>,
): readonly BoardItem[] {
  const items: BoardItem[] = [];
  for (const resource of source.list()) {
    try {
      const printed = source.print(resource);
      if (printed) {
        items.push(
          printResource(source, resource.metadata.resourceId, printed),
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
          status: "print failed",
          detail: error instanceof Error ? error.message : String(error),
          tone: "error",
        }),
      );
    }
  }
  return Object.freeze(items);
}
