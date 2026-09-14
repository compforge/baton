import type { CommandContext, CommandInput } from "@compforge/baton-plugin";
import type { Manager } from "../../src/plugin/manager.ts";
import { newId } from "../../src/event/ids.ts";

export function commandContext(namespace: string, name: string): CommandContext {
  return {
    executionId: newId("cex"), command: { namespace, name },
    verbs: {
      async submit() { throw new Error("No command execution surface in this fixture"); },
      async configureModel() { throw new Error("No command execution surface in this fixture"); },
    },
  };
}

export function executeCommand(manager: Manager, name: string, input: CommandInput) {
  const registered = manager.listCommands().find((command) => command.name === name)!;
  return manager.executeCommand(name, input, commandContext(registered.namespace, registered.name));
}
