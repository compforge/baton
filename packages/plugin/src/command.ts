/** Stable identity; namespaces are assigned by the host, never by a Plugin. */
export interface CommandRef {
  readonly namespace: string;
  readonly name: string;
}

export interface CommandInput {
  readonly argument: string;
  readonly selectedValue?: string;
  readonly searchQuery?: string;
}

export type CommandInputShape =
  | { readonly kind: "argument" }
  | { readonly kind: "none"; readonly trailingText: "reject" | "submit" };

export interface CommandAlias {
  readonly name: string;
  readonly description?: string;
  readonly boundArgument?: string;
  readonly input?: CommandInputShape;
}

export interface CommandSubmitInput {
  readonly prompt: string;
}

/** A durable Queue admission, not evidence that the Harness completed the turn. */
export interface CommandSubmitReceipt {
  readonly messageId: string;
  readonly turnId: string;
  readonly queued: boolean;
}

/**
 * Host capabilities scoped to one live Command invocation. Like PluginVerbs,
 * this is a collection of typed actions, not a model-configuration abstraction.
 */
export interface CommandVerbs {
  /** @spec Submit a new turn on the invoking Target, queueing instead of steering while busy. */
  submit(input: CommandSubmitInput): Promise<CommandSubmitReceipt>;
  /** Change the invoking Target's defaults for subsequent turns. */
  configureModel(input: { readonly model?: string; readonly effort?: string }): Promise<void>;
}

export interface CommandContext {
  readonly executionId: string;
  readonly command: CommandRef;
  readonly target?: { readonly id: string; readonly harness: string };
  readonly laneId?: string;
  readonly verbs: CommandVerbs;
}

export interface CommandOption {
  readonly name: string;
  readonly description?: string;
  readonly value: string;
}

export interface CommandPickerSearch {
  readonly mode: "local" | "remote";
  readonly query?: string;
  readonly placeholder?: string;
}

/** Presentation only. Host effects must be awaited through CommandContext.verbs. */
export type CommandResult =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "picker";
      readonly title: string;
      readonly options: readonly CommandOption[];
      readonly search?: CommandPickerSearch;
    };

/** Builtin and Plugin commands share identity, invocation and presentation contracts. */
export interface Command extends CommandRef {
  readonly description: string;
  readonly scope?: "baton" | "harness";
  readonly runPolicy?: "always" | "idle";
  readonly input?: CommandInputShape;
  readonly aliases?: readonly CommandAlias[];
  execute(input: CommandInput, context: CommandContext): Promise<CommandResult | void>;
}

/** The registrar binds namespace to the trusted provider identity. */
export type CommandDefinition = Omit<Command, "namespace">;
