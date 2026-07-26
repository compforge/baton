/** A slash command invocation routed to the owning PluginPackage. */
export interface PluginCommandInput {
  readonly argument: string;
  /** Set when the user selects an option returned by an earlier invocation. */
  readonly selectedValue?: string;
  /** Set when a remote-search picker asks the command for a fresh result page. */
  readonly searchQuery?: string;
}

export interface PluginCommandOption {
  readonly name: string;
  readonly description?: string;
  readonly value: string;
}

export interface PluginCommandPickerSearch {
  readonly mode: "local" | "remote";
  /** Query represented by this result. Used to initialize or refresh the field. */
  readonly query?: string;
  readonly placeholder?: string;
}

export type PluginCommandResult =
  | {
      readonly kind: "message";
      readonly text: string;
    }
  | {
      readonly kind: "picker";
      readonly title: string;
      readonly options: readonly PluginCommandOption[];
      readonly search?: PluginCommandPickerSearch;
    };

/**
 * Package-owned slash command. Baton owns completion and rendering; the Plugin
 * owns the domain query and interprets any selected value.
 */
export interface Command {
  readonly commandId: string;
  readonly name: string;
  readonly description: string;
  execute(
    input: PluginCommandInput,
  ): Promise<PluginCommandResult | undefined> | PluginCommandResult | undefined;
}
