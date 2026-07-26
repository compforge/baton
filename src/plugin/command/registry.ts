import type {
  Command,
  PluginCommandInput,
  PluginCommandResult,
} from "../package.ts";
import type { PluginInstance } from "../instance.ts";

export interface AvailablePluginCommand {
  readonly pluginId: string;
  readonly commandId: string;
  readonly name: string;
  readonly description: string;
}

interface ManagedPluginCommand extends AvailablePluginCommand {
  readonly handlers: Map<string, Command>;
}

interface PluginCommandRegistryOptions {
  readonly reservedNames?: readonly string[];
  readonly isInstanceActive: (pluginInstanceId: string) => boolean;
  readonly onChanged?: () => void;
}

function pluginCommandKey(pluginId: string, commandId: string): string {
  return JSON.stringify([pluginId, commandId]);
}

function commandIdentifier(name: string, value: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`${name} must use lowercase letters, digits, and hyphens`);
  }
}

function nonEmptyCommandText(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateCommandResult(
  command: AvailablePluginCommand,
  result: PluginCommandResult | undefined,
): PluginCommandResult | undefined {
  if (!result) return;
  if (result.kind === "message") {
    nonEmptyCommandText(`/${command.name} message`, result.text);
    return result;
  }
  if (result.kind !== "picker") {
    throw new Error(`/${command.name} returned an unsupported result`);
  }
  nonEmptyCommandText(`/${command.name} picker title`, result.title);
  if (
    result.options.length === 0 &&
    result.search?.mode !== "remote"
  ) {
    throw new Error(`/${command.name} picker must contain at least one option`);
  }
  if (result.search?.placeholder !== undefined) {
    nonEmptyCommandText(
      `/${command.name} picker search placeholder`,
      result.search.placeholder,
    );
  }
  const values = new Set<string>();
  for (const option of result.options) {
    nonEmptyCommandText(`/${command.name} option name`, option.name);
    nonEmptyCommandText(`/${command.name} option value`, option.value);
    if (values.has(option.value)) {
      throw new Error(`/${command.name} returned duplicate option value: ${option.value}`);
    }
    values.add(option.value);
  }
  return result;
}

/**
 * Package identity owns command definitions; active Binding identity owns the
 * executable handler. This keeps one slash entry while failing closed if the
 * same Package later has multiple configured instances.
 */
export class PluginCommandRegistry {
  private readonly commands = new Map<string, ManagedPluginCommand>();
  private readonly commandKeysByName = new Map<string, string>();
  private readonly reservedNames: ReadonlySet<string>;
  private readonly isInstanceActive: PluginCommandRegistryOptions["isInstanceActive"];
  private readonly onChanged: PluginCommandRegistryOptions["onChanged"];

  constructor(options: PluginCommandRegistryOptions) {
    this.reservedNames = new Set(options.reservedNames ?? []);
    this.isInstanceActive = options.isInstanceActive;
    this.onChanged = options.onChanged;
  }

  register(
    instance: PluginInstance,
    registered: Command,
  ): () => void {
    commandIdentifier("plugin commandId", registered.commandId);
    commandIdentifier("plugin command name", registered.name);
    nonEmptyCommandText("plugin command description", registered.description);
    if (this.reservedNames.has(registered.name)) {
      throw new Error(`plugin command name is reserved by Baton: /${registered.name}`);
    }
    const key = pluginCommandKey(instance.pluginId, registered.commandId);
    const owner = this.commandKeysByName.get(registered.name);
    if (owner && owner !== key) {
      throw new Error(`plugin command name is already registered: /${registered.name}`);
    }
    let command = this.commands.get(key);
    if (command) {
      if (
        command.name !== registered.name ||
        command.description !== registered.description
      ) {
        throw new Error(
          `plugin command definition differs across instances: ${instance.pluginId}/${registered.commandId}`,
        );
      }
      if (command.handlers.has(instance.pluginInstanceId)) {
        throw new Error(
          `plugin command already registered by ${instance.pluginInstanceId}: ${registered.commandId}`,
        );
      }
    } else {
      command = {
        pluginId: instance.pluginId,
        commandId: registered.commandId,
        name: registered.name,
        description: registered.description,
        handlers: new Map(),
      };
      this.commands.set(key, command);
      this.commandKeysByName.set(registered.name, key);
    }
    command.handlers.set(instance.pluginInstanceId, registered);
    return () => {
      const current = this.commands.get(key);
      if (!current) return;
      current.handlers.delete(instance.pluginInstanceId);
      if (current.handlers.size === 0) {
        this.commands.delete(key);
        if (this.commandKeysByName.get(current.name) === key) {
          this.commandKeysByName.delete(current.name);
        }
      }
      this.onChanged?.();
    };
  }

  list(): readonly AvailablePluginCommand[] {
    const commands: AvailablePluginCommand[] = [];
    for (const command of this.commands.values()) {
      if (
        [...command.handlers.keys()].some(this.isInstanceActive)
      ) {
        const { handlers: _handlers, ...available } = command;
        commands.push(Object.freeze(available));
      }
    }
    return Object.freeze(
      commands.sort((left, right) => left.name.localeCompare(right.name)),
    );
  }

  async execute(
    name: string,
    input: PluginCommandInput,
  ): Promise<PluginCommandResult | undefined> {
    const key = this.commandKeysByName.get(name);
    const command = key ? this.commands.get(key) : undefined;
    if (!command) throw new Error(`Unknown plugin command: /${name}`);
    const active = [...command.handlers.entries()].filter(
      ([pluginInstanceId]) => this.isInstanceActive(pluginInstanceId),
    );
    if (active.length === 0) {
      throw new Error(`Plugin command is not active: /${name}`);
    }
    if (active.length > 1) {
      throw new Error(
        `Plugin command /${name} has multiple active instances: ${active
          .map(([pluginInstanceId]) => pluginInstanceId)
          .join(", ")}`,
      );
    }
    const result = await active[0]![1].execute(Object.freeze({ ...input }));
    return validateCommandResult(command, result);
  }
}
