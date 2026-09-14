import type {
  CommandDefinition,
  CommandInput,
  CommandResult,
} from "../package.ts";
import type { PluginInstance } from "../instance.ts";
import type { CommandContext } from "@compforge/baton-plugin";
import { CommandRegistry } from "../../commands/registry.ts";
import { validateCommandResult } from "../../commands/result.ts";

export interface AvailablePluginCommand {
  readonly namespace: string;
  readonly input?: CommandDefinition["input"];
  readonly aliases?: CommandDefinition["aliases"];
  readonly runPolicy?: CommandDefinition["runPolicy"];
  readonly scope?: CommandDefinition["scope"];
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
}

interface ManagedPluginCommand extends AvailablePluginCommand {
  readonly handlers: Map<string, CommandDefinition>;
}

interface PluginCommandRegistryOptions {
  readonly reservedNames?: readonly string[];
  readonly isInstanceActive: (pluginInstanceId: string) => boolean;
  readonly onChanged?: () => void;
}

function pluginCommandKey(pluginId: string, name: string): string {
  return JSON.stringify([pluginId, name]);
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
    registered: CommandDefinition,
  ): () => void {
    const key = pluginCommandKey(instance.pluginId, registered.name);
    const declarations = new CommandRegistry();
    declarations.register({ ...registered, namespace: instance.pluginId });
    const tokens = declarations.names();
    for (const token of tokens) {
      if (this.reservedNames.has(token)) throw new Error(`plugin command name is reserved by Baton: /${token}`);
      const owner = this.commandKeysByName.get(token);
      if (owner && owner !== key) throw new Error(`plugin command name is already registered: /${token}`);
    }
    let command = this.commands.get(key);
    if (command) {
      if (
        command.name !== registered.name ||
        command.description !== registered.description ||
        command.runPolicy !== registered.runPolicy || command.scope !== registered.scope ||
        JSON.stringify(command.input) !== JSON.stringify(registered.input) ||
        JSON.stringify(command.aliases) !== JSON.stringify(registered.aliases)
      ) {
        throw new Error(
          `plugin command definition differs across instances: ${instance.pluginId}/${registered.name}`,
        );
      }
      if (command.handlers.has(instance.pluginInstanceId)) {
        throw new Error(
          `plugin command already registered by ${instance.pluginInstanceId}: ${registered.name}`,
        );
      }
    } else {
      command = {
        namespace: instance.pluginId,
        input: registered.input,
        aliases: registered.aliases,
        runPolicy: registered.runPolicy,
        scope: registered.scope,
        pluginId: instance.pluginId,
        name: registered.name,
        description: registered.description,
        handlers: new Map(),
      };
      this.commands.set(key, command);
      for (const token of tokens) this.commandKeysByName.set(token, key);
    }
    command.handlers.set(instance.pluginInstanceId, registered);
    return () => {
      const current = this.commands.get(key);
      if (!current) return;
      current.handlers.delete(instance.pluginInstanceId);
      if (current.handlers.size === 0) {
        this.commands.delete(key);
        for (const token of tokens) if (this.commandKeysByName.get(token) === key) this.commandKeysByName.delete(token);
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
    input: CommandInput,
    context: CommandContext,
  ): Promise<CommandResult | void> {
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
    if (context.command.namespace !== command.namespace || context.command.name !== command.name) {
      throw new Error("Command context does not match its registered provider");
    }
    const result = await active[0]![1].execute(Object.freeze({ ...input }), context);
    return validateCommandResult(command, result);
  }
}
