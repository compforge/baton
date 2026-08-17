import { shellCommandIsReadOnly } from "../command-effect/shell.ts";
import { READ_ONLY_COMMAND_RULES } from "../command-effect/rules.ts";

const STRUCTURED_READ_ACTIONS = new Set(["read", "listFiles", "search"]);

/**
 * Codex action aggregation stays provider-specific: native structured actions
 * are authoritative, while only `unknown` actions enter the conservative shell
 * recognizer. Unknown or malformed input fails closed as write at the adapter.
 */
export function codexCommandActionsAreReadOnly(actions: unknown): boolean {
  if (!Array.isArray(actions) || actions.length === 0) return false;
  return actions.every((action) => {
    if (!action || typeof action !== "object") return false;
    const record = action as Record<string, unknown>;
    if (typeof record.type !== "string") return false;
    if (STRUCTURED_READ_ACTIONS.has(record.type)) return true;
    return record.type === "unknown"
      && typeof record.command === "string"
      && shellCommandIsReadOnly(record.command, READ_ONLY_COMMAND_RULES);
  });
}
