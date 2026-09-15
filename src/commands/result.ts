import type { CommandRef, CommandResult } from "@compforge/baton-plugin";

function nonEmptyCommandText(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

export function validateCommandResult(
  command: CommandRef,
  result: CommandResult | void,
): CommandResult | void {
  if (result === undefined) return;
  if (!result || typeof result !== "object") throw new Error(`/${command.name} returned an invalid result`);
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
