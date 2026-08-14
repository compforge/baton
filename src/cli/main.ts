#!/usr/bin/env bun
// headless REPL：无 TUI 先跑通链路——终端里与任一已注册 Harness 对话，全部事件落 session.jsonl。
// 用法：bun src/cli/main.ts [--agent codex|claude|dsh] [--cwd <dir>] [--root <batonRoot>]
// claude 可执行文件用 BATON_CLAUDE_BIN 覆盖（如公司包装器 reclaude）。

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { Channel } from "../channel/index.ts";
import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import {
  createHarnessAdapter,
  parseHarness,
  resolveDefaultHarnessTarget,
} from "../harness/registry.ts";
import { bundledTextgenTargets } from "../session/title.ts";
import type {
  Interaction,
  InteractionResult,
} from "../interaction/types.ts";
import { SessionStore, sessionDisplayTitle } from "../store/store.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rl = createInterface({ input: stdin, output: stdout });

// headless REPL 按 kind 收集严格配对的 Interaction 结果。
async function collectInteractionResult(interaction: Interaction): Promise<InteractionResult> {
  if (interaction.kind === "permission") {
    stdout.write(`\n⚠ ${interaction.title}\n`);
    interaction.options.forEach((o, i) => stdout.write(`  ${i + 1}. ${o.name} [${o.optionId}]\n`));
    for (;;) {
      const answer = (await rl.question("approve> ")).trim();
      const byIndex = interaction.options[Number(answer) - 1];
      const byId = interaction.options.find((o) => o.optionId === answer);
      const chosen = byId ?? byIndex;
      if (chosen) return { kind: "permission", outcome: "selected", optionId: chosen.optionId };
      stdout.write("Enter an option number or optionId\n");
    }
  }
  if (interaction.kind === "hook_trust") {
    stdout.write(
      `\n⚠ Trust ${interaction.hooks.length} ${interaction.harnessName} hook${interaction.hooks.length === 1 ? "" : "s"}?\n`,
    );
    interaction.hooks.forEach((hook) => {
      stdout.write(`  - ${hook.pluginId ?? hook.source}: ${hook.sourcePath} [${hook.trustStatus}]\n`);
    });
    for (;;) {
      const answer = (await rl.question("trust current definitions? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return { kind: "hook_trust", outcome: "trusted" };
      }
      if (!answer || answer === "n" || answer === "no") {
        return { kind: "hook_trust", outcome: "skipped" };
      }
    }
  }
  if (interaction.kind === "suggested_input") {
    stdout.write(`\n? ${interaction.title}\n`);
    const answer = await rl.question(`input [${interaction.text}]> `);
    return {
      kind: "suggested_input",
      outcome: "submitted",
      blocks: [{ type: "text", text: answer.trim() || interaction.text }],
    };
  }
  if (interaction.kind === "harness_invocation") {
    stdout.write(`\n⚠ ${interaction.title}\n${interaction.prompt}\n`);
    const answer = (await rl.question("run? [Y/n] ")).trim().toLowerCase();
    return {
      kind: "harness_invocation",
      outcome: answer === "n" || answer === "no" ? "declined" : "approved",
    };
  }
  const answers: Record<string, string[]> = {};
  for (const question of interaction.questions) {
    stdout.write(`\n? ${question.header}: ${question.question}\n`);
    question.choices?.forEach((choice, index) =>
      stdout.write(`  ${index + 1}. ${choice.label} — ${choice.description ?? ""}\n`),
    );
    const suffix = question.multiSelect ? " (comma-separated choices)" : "";
    const answer = (await rl.question(`answer${suffix}> `)).trim();
    const values = question.multiSelect ? answer.split(",").map((value) => value.trim()).filter(Boolean) : [answer];
    answers[question.questionId] = values.map((value) => {
      const choice = question.choices?.[Number(value) - 1];
      return choice?.value ?? value;
    });
  }
  return { kind: "question", outcome: "answered", answers };
}

async function main(): Promise<void> {
  const rootArg = argValue("--root");
  ensureConfigFile(rootArg);
  const config = loadConfig(rootArg);
  const requested = argValue("--agent") ?? config.defaultAgent;
  // registry 全路径接管：不再手写 harness 分支（未知值以前静默落到 codex，现在显式报错）
  const agentName = parseHarness(requested);
  if (!agentName) {
    stdout.write(`unknown agent: ${requested}\n`);
    process.exit(1);
  }
  const cwd = argValue("--cwd") ?? process.cwd();
  const store = new SessionStore(rootArg, { level: config.logLevel });
  const session = store.createSession({ cwd });
  session.log({
    level: "info",
    source: "baton",
    component: "session.lifecycle",
    message: "Headless session created",
    attributes: { cwd },
  });
  stdout.write(`baton session: ${session.id}\nlog: ${session.dir}/session.jsonl\n`);

  const target = resolveDefaultHarnessTarget(agentName);
  if (!target) throw new Error(`No default HarnessTarget registered for Harness: ${agentName}`);
  const channel = new Channel({
    session,
    controller: {
      mentionBudgetChars: config.mentionBudgetChars,
      createAdapter: (resolvedTarget, handlers) =>
        createHarnessAdapter(resolvedTarget, {
          ...handlers,
          config,
          rootDir: store.rootDir,
        }),
      resolveTarget: resolveDefaultHarnessTarget,
      textgenTargets: bundledTextgenTargets(),
      ...(config.textgenPrefer ? { textgenPrefer: config.textgenPrefer } : {}),
      ...(config.textgenModels ? { textgenModels: config.textgenModels } : {}),
    },
  });
  const controller = channel.controller;

  let sawOutput = false;
  let interactionChain = Promise.resolve();
  const unsubscribe = channel.subscribe((_projection, event) => {
    if (event.kind === "agent_message_chunk" && event.payload.content.type === "text") {
      if (!sawOutput) {
        stdout.write(`${event.harness ?? target.harness}> `);
        sawOutput = true;
      }
      stdout.write((event.payload.content as { text: string }).text);
    } else if (event.kind === "tool_call_update" && event.payload.title) {
      stdout.write(`\n[tool:${event.payload.status ?? ""}] ${event.payload.title}\n`);
    } else if (event.kind === "_baton_error_update") {
      stdout.write(`\nerror: ${event.payload.message}\n`);
    }
    if (event.kind === "interaction.requested") {
      interactionChain = interactionChain
        .then(async () => {
          const result = await collectInteractionResult(event.payload);
          const receipt = await channel.resolveInteraction({
            kind: "interaction_response",
            interactionId: event.payload.interactionId,
          }, async () => result);
          if (!receipt.result) {
            stdout.write(`\ninteraction ${event.payload.interactionId} is no longer pending\n`);
          }
        })
        .catch((error) => {
          stdout.write(
            `\ninteraction failed: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
    }
  });
  stdout.write(`${target.harness} target: ${target.id}\nType to chat, /exit to quit\n\n`);

  for (;;) {
    const line = (await rl.question("you> ")).trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/sessions") {
      for (const m of store.listSessions({ cwd })) {
        stdout.write(`  @${m.batonSessionId}  ${sessionDisplayTitle(m)}\n`);
      }
      continue;
    }

    // @bs_xxx 急切展开：把被引用会话的紧凑摘要拼进 prompt（见 docs/workflow.md）
    session.setPreviewIfEmpty(line);
    const { prompt, mentions } = expandMentions(store, line, config.mentionBudgetChars);
    if (mentions.length) stdout.write(`(injected context summaries from ${mentions.length} session(s))\n`);

    sawOutput = false;
    try {
      const receipt = await channel.submitPrompt({
        kind: "prompt",
        text: line,
        harnessTargetId: target.id,
      }, async () => [{ type: "text", text: prompt }]);
      const sent = receipt.result;
      if (sent.effective === "new_turn") await sent.outcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`\nerror: ${message}\n`);
      continue;
    }
    const summary = session.ledger
      .read()
      .findLast((event) => event.kind === "_baton_turn_summary")?.payload;
    stdout.write(
      `\n— turn done (${summary?.stopReason ?? "?"}, in:${summary?.usage?.inputTokens ?? 0} out:${summary?.usage?.outputTokens ?? 0})\n\n`,
    );
  }

  await interactionChain;
  unsubscribe();
  await channel.close();
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
