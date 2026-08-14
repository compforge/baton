export type BatonTerminationSignal = "SIGTERM" | "SIGHUP";

interface SignalProcess {
  on(signal: BatonTerminationSignal, listener: () => void): void;
  off(signal: BatonTerminationSignal, listener: () => void): void;
}

export interface TerminationHandlersOptions {
  process: SignalProcess;
  shutdown(signal: BatonTerminationSignal): Promise<void>;
  exit(code: number): void;
  timeoutMs: number;
  onError?(error: unknown): void;
}

export function signalExitCode(signal: BatonTerminationSignal): number {
  return signal === "SIGHUP" ? 129 : 143;
}

/**
 * First signal gets one bounded graceful shutdown. A second signal, timeout,
 * or cleanup failure exits immediately. SIGKILL remains intentionally outside
 * the contract because no process can intercept it.
 */
export function installTerminationHandlers(options: TerminationHandlersOptions): () => void {
  let terminating = false;
  let exited = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  const cleanup = (): void => {
    options.process.off("SIGTERM", onSigterm);
    options.process.off("SIGHUP", onSighup);
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
  };
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    cleanup();
    options.exit(code);
  };
  const handle = (signal: BatonTerminationSignal): void => {
    const code = signalExitCode(signal);
    if (terminating) {
      finish(code);
      return;
    }
    terminating = true;
    deadline = setTimeout(() => finish(code), options.timeoutMs);
    deadline.unref?.();
    void Promise.resolve()
      .then(() => options.shutdown(signal))
      .then(
        () => finish(code),
        (error) => {
          options.onError?.(error);
          finish(code);
        },
      );
  };
  const onSigterm = (): void => handle("SIGTERM");
  const onSighup = (): void => handle("SIGHUP");

  options.process.on("SIGTERM", onSigterm);
  options.process.on("SIGHUP", onSighup);
  return cleanup;
}
