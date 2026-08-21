export const BATON_DAEMON_PROTOCOL_VERSION = 1 as const;

export interface BatonDaemonStatus {
  readonly protocolVersion: typeof BATON_DAEMON_PROTOCOL_VERSION;
  readonly batonVersion: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly rootDir: string;
  readonly sessionCount: number;
  readonly pluginWorkerCount: number;
  readonly pendingHumanActions: number;
}

export type BatonDaemonRequest =
  | {
      readonly id: number;
      readonly method: "status";
    }
  | {
      readonly id: number;
      readonly method: "stop";
    }
  | {
      readonly id: number;
      readonly method: "session.attach";
      readonly params: {
        readonly sessionId: string;
        readonly projectId: string;
        readonly cwd: string;
      };
    }
  | {
      readonly id: number;
      readonly method: "session.heartbeat" | "session.detach" | "inbox.list";
      readonly params: { readonly sessionId: string };
    }
  | {
      readonly id: number;
      readonly method: "inbox.claim" | "inbox.begin-execution";
      readonly params: {
        readonly actionId: string;
        readonly sessionId: string;
      };
    }
  | {
      readonly id: number;
      readonly method: "inbox.complete";
      readonly params: {
        readonly actionId: string;
        readonly sessionId: string;
        readonly result: unknown;
        readonly review: boolean;
      };
    }
  | {
      readonly id: number;
      readonly method: "inbox.review";
      readonly params: {
        readonly actionId: string;
        readonly sessionId: string;
        readonly accepted: boolean;
      };
    };

export type BatonDaemonResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    };
