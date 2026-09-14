import type { Command, CommandContext, CommandInput, CommandResult, ViewInputRecord } from "@compforge/baton-plugin";
import type { Channel } from "../channel/index.ts";
import { saveModelPreference } from "../config/model-preferences.ts";
import { saveEffortPreference } from "../config/effort-preferences.ts";
import { newId } from "../event/ids.ts";
import type { HarnessTarget } from "../harness/target.ts";
import { MAIN_LANE_ID } from "../lane.ts";
import { validateCommandResult } from "./result.ts";

export interface CommandPreferences {
  readonly rootDir: string;
  readonly models: Record<string, string>;
  readonly efforts: Record<string, string>;
}

/**
 * @spec Builtin and Worker commands receive the same invocation-scoped capabilities; results are presentation only.
 * @rule Target and causal identity come from the accepted Human input, never from a Worker request. Search has no action authority.
 */
export async function executeCommand(
  channel: Channel,
  command: Command,
  input: CommandInput,
  record: ViewInputRecord,
  target: HarnessTarget | undefined,
  preferences?: CommandPreferences,
): Promise<CommandResult | void> {
  let active = true;
  const assertAction = () => {
    if (!active || channel.lifecycle !== "open") throw new Error("Command execution is no longer active");
    if (input.searchQuery !== undefined) throw new Error("Command search cannot invoke actions");
    if (!target) throw new Error("Command requires a Session target");
    return target;
  };
  const context: CommandContext = Object.freeze({
    executionId: newId("cex"),
    command: Object.freeze({ namespace: command.namespace, name: command.name }),
    ...(target ? { target: Object.freeze({ ...target }), laneId: MAIN_LANE_ID } : {}),
    verbs: Object.freeze({
      submit: async (request) => {
        const selected = assertAction();
        if (typeof request.prompt !== "string" || !request.prompt.trim()) throw new Error("Command prompt must not be empty");
        const identity = { messageId: newId("m"), turnId: newId("t") };
        const receipt = await channel.controller.sendTurn(selected.id, [{ type: "text", text: request.prompt }], {
          identity, parentEventId: record.eventId, followUp: true,
        });
        if (receipt.effective !== "new_turn") throw new Error("Command submission unexpectedly steered an active turn");
        // Command returns admission only. Controller records failure/terminal Events;
        // consume its caller-facing rejection without creating a second verdict.
        void receipt.outcome.catch(() => {});
        return { ...identity, queued: receipt.queued };
      },
      configureModel: async (request) => {
        const selected = assertAction();
        if (!preferences) throw new Error("Model preferences are unavailable on this surface");
        if (request.model === undefined && request.effort === undefined) throw new Error("Model or effort is required");
        for (const value of [request.model, request.effort]) {
          if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error("Model and effort must be non-empty strings");
        }
        const configuration = request.model !== undefined && request.effort !== undefined
          ? { setting: "model_configuration" as const, value: { model: request.model, effort: request.effort } }
          : { setting: request.model !== undefined ? "model" as const : "effort" as const, value: request.model ?? request.effort! };
        await channel.dispatchConfiguration({ kind: "configuration", ...configuration, harnessTargetId: selected.id }, async () => {
          assertAction();
          if (request.model !== undefined && request.effort !== undefined) {
            await channel.controller.setModelConfiguration(selected.id, { model: request.model, effort: request.effort });
          } else if (request.model !== undefined) {
            await channel.controller.setModel(selected.id, request.model);
          } else {
            await channel.controller.setEffort(selected.id, request.effort!);
          }
          if (request.model !== undefined) {
            saveModelPreference(preferences.rootDir, selected.id, request.model);
            if (request.model === "default") delete preferences.models[selected.id];
            else preferences.models[selected.id] = request.model;
          }
          if (request.effort !== undefined) {
            saveEffortPreference(preferences.rootDir, selected.id, request.effort);
            if (request.effort === "default") delete preferences.efforts[selected.id];
            else preferences.efforts[selected.id] = request.effort;
          }
        });
      },
    } satisfies CommandContext["verbs"]),
  });
  try {
    if (command.runPolicy === "idle" && channel.controller.activeTurnId) throw new Error(`/${command.name} requires an idle Session`);
    return validateCommandResult(command, await command.execute(Object.freeze({ ...input }), context));
  } finally {
    active = false;
  }
}
