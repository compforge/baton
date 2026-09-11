import type { ReadOnlyCommandRule } from "./shell.ts";

const OPTIONS_WITH_VALUES = new Set([
  "-f",
  "-s",
  "-w",
  "--check-chars",
  "--skip-chars",
  "--skip-fields",
]);

/** uniq writes to stdout unless it receives both an input and an output operand. */
export const uniqCommandIsReadOnly: ReadOnlyCommandRule = (args) => {
  let operands = 0;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && OPTIONS_WITH_VALUES.has(arg)) {
      if (!args[index + 1]) return false;
      index += 1;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) continue;
    operands += 1;
    if (operands > 1) return false;
  }
  return true;
};
