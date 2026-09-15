import type { Command, CommandInputShape } from "@compforge/baton-plugin";
export type { CommandDefinition } from "@compforge/baton-plugin";

export interface DirectCommandable {
  kind: "command";
  name: string;
  description: string;
  command: Command;
  input: CommandInputShape;
}

export interface AliasCommandable {
  kind: "alias";
  name: string;
  description: string;
  command: Command;
  input: CommandInputShape;
  boundArgument?: string;
}

/** chat-tui 可匹配的入口；它可以是 canonical Command，也可以是指向它的 Alias。 */
export type Commandable = DirectCommandable | AliasCommandable;

export interface CommandInvocation {
  command: Command;
  invokedAs: string;
  argument: string;
  trailingText?: string;
}

function commandToken(label: string, value: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error(`${label} must use lowercase letters, digits, and hyphens`);
  }
}

export class CommandRegistry {
  private readonly byName = new Map<string, Commandable>();
  private readonly entries: Commandable[] = [];

  register(command: Command): void {
    if (!command.namespace.trim() || !command.description.trim()) throw new Error("Command namespace and description must not be empty");
    commandToken("command name", command.name);
    const commandables: Commandable[] = [{
      kind: "command",
      name: command.name,
      description: command.description,
      command,
      input: command.input ?? { kind: "argument" },
    }];
    for (const alias of command.aliases ?? []) {
      commandToken("command alias", alias.name);
      commandables.push({
        kind: "alias",
        name: alias.name,
        description: alias.description ?? command.description,
        command,
        input: alias.input ?? command.input ?? { kind: "argument" },
        ...(alias.boundArgument === undefined
          ? {}
          : { boundArgument: alias.boundArgument }),
      });
    }

    const registered = new Set<string>();
    for (const commandable of commandables) {
      if (registered.has(commandable.name) || this.byName.has(commandable.name)) {
        throw new Error(`duplicate commandable: /${commandable.name}`);
      }
      registered.add(commandable.name);
    }
    for (const commandable of commandables) {
      this.add(commandable);
    }
  }

  list(): readonly Commandable[] {
    return this.entries;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  /**
   * @spec Alias 只改变 slash 调用形式：它先绑定 canonical Command 参数；无剩余命令参数且显式允许 trailing text 的 Commandable，才把后缀作为独立 Prompt 返回。
   */
  resolve(name: string, remainder: string): CommandInvocation | null {
    const commandable = this.byName.get(name);
    if (!commandable) return null;
    if (commandable.input.kind === "argument") {
      return {
        command: commandable.command,
        invokedAs: commandable.name,
        argument: commandable.kind === "alias" && commandable.boundArgument !== undefined
          ? commandable.boundArgument
          : remainder,
      };
    }
    if (remainder && commandable.input.trailingText === "reject") {
      throw new Error(`/${commandable.name} takes no arguments`);
    }
    return {
      command: commandable.command,
      invokedAs: commandable.name,
      argument: commandable.kind === "alias"
        ? commandable.boundArgument ?? ""
        : "",
      ...(remainder ? { trailingText: remainder } : {}),
    };
  }

  private add(commandable: Commandable): void {
    this.byName.set(commandable.name, commandable);
    this.entries.push(commandable);
  }
}
