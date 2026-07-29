import type {
  PluginDataDirectories,
  PluginInstance,
  PluginSessionContext,
  Resource,
  ResourceListOptions,
  ResourceOwnerReference,
  ResourceType,
  ToastMessage,
} from "@compforge/baton-plugin";
import type { PluginLogRecord } from "../package.ts";

export interface PluginPackageEntry {
  readonly pluginId: string;
  readonly version: string;
  readonly entryUrl: string;
}

export interface CommandRegistration {
  readonly kind: "command";
  readonly handlerId: string;
  readonly commandId: string;
  readonly name: string;
  readonly description: string;
}

export interface ContextProviderRegistration {
  readonly kind: "context-provider";
  readonly providerKind: string;
  readonly searchHandlerId: string;
  readonly provideHandlerId: string;
}

export interface ResourceSourceRegistration {
  readonly type: "resource";
  readonly sourceId: string;
  readonly startHandlerId: string;
}

export interface CronSourceRegistration {
  readonly type: "cron";
  readonly sourceId: string;
  readonly cron: string;
  readonly timeZone: string;
}

export type SourceRegistration =
  | ResourceSourceRegistration
  | CronSourceRegistration;

export interface WatchRegistration {
  readonly resourceType: ResourceType;
  readonly createHandlerId: string;
  readonly updateHandlerId: string;
  readonly deleteHandlerId: string;
}

export interface ControllerRegistration {
  readonly kind: "controller";
  readonly controllerId: string;
  readonly resourceType: ResourceType;
  readonly reconcileHandlerId: string;
  readonly presentHandlerId?: string;
  readonly maxConcurrency?: number;
  readonly sources: readonly SourceRegistration[];
  readonly watches: readonly WatchRegistration[];
}

export type PluginRegistration =
  | CommandRegistration
  | ContextProviderRegistration
  | ControllerRegistration;

export interface ActivationResult {
  readonly registrations: readonly PluginRegistration[];
}

export type RunnerRequest =
  | {
      readonly method: "activate";
      readonly entry: PluginPackageEntry;
      readonly instance: PluginInstance;
      readonly session: PluginSessionContext;
      readonly dataDirs: PluginDataDirectories;
    }
  | {
      readonly method: "invoke";
      readonly handlerId: string;
      readonly args: readonly unknown[];
    }
  | {
      readonly method: "start-source";
      readonly handlerId: string;
      readonly sourceRunId: string;
    }
  | {
      readonly method: "stop-source";
      readonly sourceRunId: string;
    }
  | {
      readonly method: "close";
    };

export type HostRequest =
  | {
      readonly method: "resource.get";
      readonly type: ResourceType;
      readonly name: string;
    }
  | {
      readonly method: "resource.list";
      readonly type: ResourceType;
      readonly options?: ResourceListOptions;
    }
  | {
      readonly method: "resource.create";
      readonly type: ResourceType;
      readonly init: {
        readonly name: string;
        readonly labels?: Readonly<Record<string, string>>;
        readonly annotations?: Readonly<Record<string, string>>;
        readonly owner?: ResourceOwnerReference;
        readonly spec: unknown;
      };
    }
  | {
      readonly method: "resource.delete";
      readonly type: ResourceType;
      readonly name: string;
    }
  | {
      readonly method: "resource.patchMetadata";
      readonly resource: Readonly<Resource<unknown, unknown>>;
      readonly patch: {
        readonly labels?: Readonly<Record<string, string | null>>;
        readonly annotations?: Readonly<Record<string, string | null>>;
      };
    }
  | {
      readonly method: "resource.patchStatus";
      readonly resource: Readonly<Resource<unknown, unknown>>;
      readonly patch: Readonly<Record<string, unknown>>;
    }
  | {
      readonly method: "source.emit";
      readonly sourceRunId: string;
      readonly resource: {
        readonly name: string;
        readonly labels?: Readonly<Record<string, string>>;
        readonly annotations?: Readonly<Record<string, string>>;
        readonly owner?: ResourceOwnerReference;
        readonly spec: unknown;
      };
    };

export type RunnerSignal =
  | {
      readonly kind: "toast";
      readonly message: ToastMessage;
    }
  | {
      readonly kind: "log";
      readonly record: PluginLogRecord;
    }
  | {
      readonly kind: "source-error";
      readonly sourceRunId: string;
      readonly error: SerializedError;
    };

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

export interface ParentCall {
  readonly kind: "parent-call";
  readonly callId: number;
  readonly request: RunnerRequest;
}

export type ChildReply =
  | {
      readonly kind: "child-reply";
      readonly callId: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: "child-reply";
      readonly callId: number;
      readonly ok: false;
      readonly error: SerializedError;
    };

export interface ChildCall {
  readonly kind: "child-call";
  readonly callId: number;
  readonly request: HostRequest;
}

export type ParentReply =
  | {
      readonly kind: "parent-reply";
      readonly callId: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: "parent-reply";
      readonly callId: number;
      readonly ok: false;
      readonly error: SerializedError;
    };

export type ParentMessage =
  | ParentCall
  | ParentReply;

export type ChildMessage =
  | ChildReply
  | ChildCall
  | RunnerSignal;

export function serializedError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(error.cause === undefined
        ? {}
        : { cause: serializedError(error.cause) }),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

export function restoredError(error: SerializedError): Error {
  const restored = new Error(
    error.message,
    error.cause === undefined
      ? undefined
      : { cause: restoredError(error.cause) },
  );
  restored.name = error.name;
  if (error.stack !== undefined) restored.stack = error.stack;
  return restored;
}
