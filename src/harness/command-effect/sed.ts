import type { ReadOnlyCommandRule } from "./shell.ts";

const READ_ONLY_OPTIONS = new Set(["-n", "--quiet", "--silent"]);
const PRINT_SCRIPT = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?p$/;

/**
 * Recognize only sed's common print-range form. General sed programs can write
 * files (`w`) or execute commands (`e`), so broader scripts must fail closed.
 */
export const sedCommandIsReadOnly: ReadOnlyCommandRule = (args) => {
  const scripts: string[] = [];
  let index = 0;
  let optionsEnded = false;

  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") {
      optionsEnded = true;
      index += 1;
      break;
    }
    if (READ_ONLY_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg === "-e" || arg === "--expression") {
      const script = args[index + 1];
      if (!script) return false;
      scripts.push(script);
      index += 2;
      continue;
    }
    if (arg.startsWith("-e") && arg.length > 2) {
      scripts.push(arg.slice(2));
      index += 1;
      continue;
    }
    if (arg.startsWith("--expression=")) {
      scripts.push(arg.slice("--expression=".length));
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return false;
    break;
  }

  if (scripts.length === 0) {
    const script = args[index];
    if (!script) return false;
    scripts.push(script);
    index += 1;
  }
  if (!scripts.every((script) => PRINT_SCRIPT.test(script))) return false;

  // Options after the script are still interpreted by sed. Only `--` can turn
  // a dash-prefixed remainder into an unambiguous file operand.
  for (; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith("-")) return false;
  }
  return true;
};
