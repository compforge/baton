#!/usr/bin/env bun
// baton 统一命令入口（bun link 后全局可用）：
//   baton            交互式 TUI（默认）
//   baton tui        同上
//   baton repl       headless REPL（--agent codex|cx|claude|cc）
//   baton resume     继续 BatonSession（无参 = cwd 最近一个，同 -c）
//   baton fork       fork BatonSession 并进入新会话
//   baton sessions   列出当前项目的 baton 会话
//   baton plugins    管理 Marketplace 与 Plugin Package
//   baton version    显示版本
//   baton help       帮助

import packageJson from "../../package.json" with { type: "json" };
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { ensureConfigFile, loadConfig } from "../config/config.ts";
import {
  adoptNativeSession,
  forkNativeSession,
  resolveNativeSession,
  type ResolvedNativeSession,
} from "../harness/native-session.ts";
import { pluginKey } from "../plugin/identity.ts";
import { MarketplaceRegistry, type MarketplaceSource } from "../plugin/marketplace/index.ts";
import { PluginSettingsStore } from "../plugin/settings.ts";
import { sessionTreeRows, treeRowPrefix } from "../store/session-tree.ts";
import { SessionStore, sessionDisplayTitle } from "../store/store.ts";

const HELP = `baton — one durable terminal session across coding-agent harnesses

Usage:
  baton [--cwd <dir>] [-c|--continue] [-s|--session <id>]
                        start the chat TUI; creates a new BatonSession by default,
                        -c continues the latest session in the cwd, -s opens a
                        specific session; /codex (/cx) and /claude (/cc) switch harness
  baton repl [--agent codex|cx|claude|cc] [--cwd <dir>]   headless REPL
  baton resume [bs_xxx|native-id|cx:<id>|cc:<id>]
                        resume a BatonSession or adopt a Codex/Claude Code native
                        session; bare native ids are detected read-only, while cx:
                        and cc: explicitly disambiguate the Harness; without an id shows a
                        session list for the current project first (enter resume · esc cancel ·
                        ctrl+c quit; starts fresh if there is no session yet)
  baton fork [bs_xxx|native-id|cx:<id>|cc:<id>|--last]
                        fork a BatonSession or a Codex/Claude Code native session
                        and open the Baton-owned child; bs_ forks live in the current
                        project (cwd or --cwd), while native forks stay in their
                        native source project; without an id shows
                        current-project sessions to pick the source (--last
                        forks the latest in cwd)
  baton sessions [--tree] [--cwd <dir>]
                        list current-project sessions (--tree shows fork
                        lineage; reference with @<id> in the input)
  baton logs [bs_xxx] [--level <level>] [--component <prefix>]
             [--plugin <plugin-id>] [--tail <count>] [--json] [--cwd <dir>]
                        inspect the latest or selected Session's structured
                        Baton, Harness, and Plugin logs
  baton plugins marketplace add <path-or-git-url> [--ref <git-ref>] [--root <dir>]
                        register a local or Git Marketplace
  baton plugins marketplace remove <name> [--root <dir>]
                        unregister a Marketplace
  baton plugins marketplace list [--root <dir>]
                        list registered Marketplaces
  baton plugins available [--marketplace <name>] [--root <dir>]
                        list Plugin Packages available from Marketplaces
  baton plugins install <plugin-id> [--marketplace <name>] [--root <dir>]
                        install and globally enable an immutable Plugin Package
  baton plugins list [--root <dir>]
                        list installed Plugin Packages
  baton version         show version (also --version / -V)
  baton help            this help

Config:
  ~/.baton/config.yaml      generated on first run; defaultAgent / claudeExecutable /
                            codexCommand / codexApprovalReviewer /
                            mentionBudgetChars / showThoughts / logLevel
  ~/.baton/plugin.yaml      globally enabled plugins keyed by plugin@marketplace
  BATON_CLAUDE_BIN          env var, takes precedence over claudeExecutable in config.yaml
`;

const cmd = process.argv[2];

switch (cmd) {
  case "version":
  case "--version":
  case "-V":
    console.log(`baton ${packageJson.version}`);
    process.exit(0);
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    process.exit(0);
}

// 无子命令或直接跟 flag（如 baton --cwd x）都进 TUI；
// 注意不能在 import 后 exit——TUI 靠事件循环常驻
if (cmd === undefined || cmd === "tui" || cmd.startsWith("-")) {
  await import("../tui/main.tsx");
} else {
  await run(cmd);
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 子命令后的首个位置参数（跳过 flag 及其值），如 `baton fork bs_xxx --cwd /x` 的 bs_xxx */
function positionalAfterCommand(): string | undefined {
  return positionalArguments(3, new Set(["--cwd", "--root", "--session", "-s"]))[0];
}

function positionalArguments(start: number, flagsWithValue: ReadonlySet<string>): string[] {
  const positional: string[] = [];
  for (let i = start; i < process.argv.length; i++) {
    const token = process.argv[i] as string;
    if (token.startsWith("-")) {
      if (flagsWithValue.has(token)) i++;
      continue;
    }
    positional.push(token);
  }
  return positional;
}

function sourceLabel(source: MarketplaceSource): string {
  return source.kind === "local"
    ? `local ${source.path}`
    : `git ${source.url}${source.ref ? `#${source.ref}` : ""} (${source.revision.slice(0, 12)})`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function chooseNativeSession(
  matches: readonly ResolvedNativeSession[],
): Promise<ResolvedNativeSession> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Native session id exists in more than one Harness:");
    matches.forEach((match, index) => {
      const title = match.source.title ? ` — ${match.source.title}` : "";
      console.log(`  ${index + 1}. ${match.target.harness}${title}`);
    });
    for (;;) {
      const answer = (await rl.question("Choose Harness> ")).trim();
      const selected = matches[Number(answer) - 1];
      if (selected) return selected;
      console.log(`Enter 1-${matches.length}, or use cx:<id> / cc:<id>.`);
    }
  } finally {
    rl.close();
  }
}

async function resolveNative(
  reference: string,
  options: { root?: string; cwd: string },
): Promise<{
  match: ResolvedNativeSession;
  config: ReturnType<typeof loadConfig>;
}> {
  ensureConfigFile(options.root);
  const config = loadConfig(options.root);
  const match = await resolveNativeSession(reference, {
    config,
    cwd: options.cwd,
    ...(process.stdin.isTTY && process.stdout.isTTY
      ? { choose: chooseNativeSession }
      : {}),
  });
  return { match, config };
}

async function run(command: string): Promise<void> {
  switch (command) {
    case "repl":
      await import("./main.ts");
      break;
    // resume/fork 都转译成 TUI 入口已支持的 flags 再进 TUI，
    // 打开语义（锁、crash recovery）统一收在 openBatonSession，不在这里分叉。
    // 无 id 时默认进前置会话选择屏（对齐 codex CLI）：不预先打开任何会话，
    // Enter 选中才 resume / 落盘 fork，Esc/Ctrl+C 取消退出
    case "resume": {
      const id = positionalAfterCommand();
      if (!id || id.startsWith("bs_")) {
        process.argv.push(...(id ? ["--session", id] : ["--pick-session", "resume"]));
        await import("../tui/main.tsx");
        break;
      }
      const root = argValue("--root");
      const cwd = argValue("--cwd") ?? process.cwd();
      // Native resume may adopt a new BatonSession, so reject non-interactive
      // invocations before writing anything, matching the existing TUI contract.
      if (!process.stdout.isTTY) fail("baton resume requires a real terminal (TTY)");
      try {
        const store = new SessionStore(root);
        const { match } = await resolveNative(id, { root, cwd });
        const opened = adoptNativeSession(store, match, { cwd });
        console.log(
          `${opened.reused ? "resuming" : "adopted"} ${match.target.harness} native session ${match.source.nativeSessionId} as ${opened.session.id}`,
        );
        process.argv.push("--session", opened.session.id);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      await import("../tui/main.tsx");
      break;
    }
    case "fork": {
      const positional = positionalAfterCommand();
      // 显式 id / --last / 非 TTY（管道、CI）直通老路径
      if (!positional && !process.argv.includes("--last") && process.stdout.isTTY) {
        process.argv.push("--pick-session", "fork");
        await import("../tui/main.tsx");
        break;
      }
      const store = new SessionStore(argValue("--root"));
      const cwd = argValue("--cwd") ?? process.cwd();
      const sourceId = positional ?? store.listSessions({ cwd })[0]?.batonSessionId;
      if (!sourceId) {
        console.error(`no baton session to fork in ${cwd} (run baton first, or pass a session id)`);
        process.exit(1);
      }
      let childId: string;
      try {
        if (sourceId.startsWith("bs_")) {
          // 跨 project fork：历史跟源 session 走，fork 后的 project 跟命令执行位置走
          childId = store.forkSession(sourceId, { cwd }).id;
          console.log(`forked ${sourceId} → ${childId}`);
        } else {
          const root = argValue("--root");
          const { match, config } = await resolveNative(sourceId, { root, cwd });
          const opened = await forkNativeSession(store, match, {
            config,
            cwd,
          });
          childId = opened.session.id;
          console.log(
            `forked ${match.target.harness} native session ${match.source.nativeSessionId} → ${childId}`,
          );
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      // fork 本身是纯存储操作：无 TTY（管道/CI）时创建成功即成功退出，
      // 不能先落盘再因 TUI 起不来 exit 1——重试会制造一堆多余的 fork
      if (!process.stdout.isTTY) {
        console.log(`open it with: baton resume ${childId}`);
        break;
      }
      process.argv.push("--session", childId);
      await import("../tui/main.tsx");
      break;
    }
    case "sessions": {
      const store = new SessionStore(argValue("--root"));
      const cwd = argValue("--cwd") ?? process.cwd();
      const sessions = store.listSessions({ cwd });
      if (sessions.length === 0) {
        console.log(`(no sessions in ${cwd} yet — run baton or baton repl first)`);
        break;
      }
      // --tree：fork 谱系视图，与 TUI picker 的 tree mode 共用同一投影
      const rows = process.argv.includes("--tree")
        ? sessionTreeRows(sessions)
        : sessions.map((meta) => ({ meta, depth: 0 }));
      for (const { meta, depth } of rows) {
        const harnesses = meta.harnessSessions
          ? Object.keys(meta.harnessSessions).join(",")
          : "-";
        console.log(
          `${treeRowPrefix(depth)}@${meta.batonSessionId}  [${harnesses}]  ${sessionDisplayTitle(meta)}  (${meta.createdAt})`,
        );
      }
      break;
    }
    case "logs":
      runLogs();
      break;
    case "plugins":
      await runPlugins();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

interface StoredLogRecord {
  readonly timestamp?: string;
  readonly level?: string;
  readonly source?: string;
  readonly component?: string;
  readonly message?: string;
  readonly pluginId?: string;
  readonly [key: string]: unknown;
}

function runLogs(): void {
  const store = new SessionStore(argValue("--root"));
  const cwd = argValue("--cwd") ?? process.cwd();
  const sessionId = positionalArguments(
    3,
    new Set(["--root", "--cwd", "--level", "--component", "--plugin", "--tail"]),
  )[0] ?? store.listSessions({ cwd })[0]?.batonSessionId;
  if (!sessionId) fail(`no baton session found in ${cwd}`);
  const session = store.openSession(sessionId);
  const records = [`${join(session.dir, "session.log")}.1`, join(session.dir, "session.log")]
    .flatMap((path) => readLogRecords(path));
  const minimumLevel = argValue("--level");
  const component = argValue("--component");
  const pluginId = argValue("--plugin");
  const priorities: Readonly<Record<string, number>> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  if (minimumLevel && priorities[minimumLevel] === undefined) {
    fail("--level must be debug, info, warn, or error");
  }
  const filtered = records.filter((record) =>
    (!minimumLevel ||
      (priorities[record.level ?? ""] ?? 0) >= (priorities[minimumLevel] as number)) &&
    (!component || record.component?.startsWith(component)) &&
    (!pluginId || record.pluginId === pluginId)
  );
  const tailArg = argValue("--tail");
  const tail = tailArg === undefined ? filtered.length : Number(tailArg);
  if (!Number.isSafeInteger(tail) || tail < 0) fail("--tail must be a non-negative integer");
  for (const record of tail === 0 ? [] : filtered.slice(-tail)) {
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(record));
      continue;
    }
    const plugin = record.pluginId ? ` plugin=${record.pluginId}` : "";
    console.log(
      `${record.timestamp ?? "-"} ${(record.level ?? "info").toUpperCase().padEnd(5)} ` +
        `${record.component ?? record.source ?? "baton"}${plugin} ${record.message ?? ""}`,
    );
  }
}

function readLogRecords(path: string): StoredLogRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as StoredLogRecord];
      } catch {
        return [];
      }
    });
}

async function runPlugins(): Promise<void> {
  const args = positionalArguments(
    3,
    new Set(["--root", "--ref", "--marketplace"]),
  );
  const registry = new MarketplaceRegistry({ rootDir: argValue("--root") });
  const settings = new PluginSettingsStore(registry.rootDir);
  try {
    if (args[0] === "marketplace" && args[1] === "add") {
      const source = args[2];
      if (!source) fail("Usage: baton plugins marketplace add <path-or-git-url> [--ref <git-ref>]");
      const marketplace = await registry.add(source, { ref: argValue("--ref") });
      console.log(`added marketplace ${marketplace.name}  ${sourceLabel(marketplace.source)}`);
      return;
    }
    if (args[0] === "marketplace" && args[1] === "remove") {
      const name = args[2];
      if (!name) fail("Usage: baton plugins marketplace remove <name>");
      registry.remove(name);
      console.log(`removed marketplace ${name}`);
      return;
    }
    if (args[0] === "marketplace" && args[1] === "list") {
      const marketplaces = registry.list();
      if (marketplaces.length === 0) {
        console.log("(no marketplaces registered)");
        return;
      }
      for (const marketplace of marketplaces) {
        console.log(`${marketplace.name}  ${sourceLabel(marketplace.source)}`);
      }
      return;
    }
    if (args[0] === "available") {
      await registry.refresh();
      const available = registry.available({ marketplace: argValue("--marketplace") });
      if (available.length === 0) {
        console.log("(no Plugin Packages available)");
        return;
      }
      for (const plugin of available) {
        const display = plugin.manifest.displayName
          ? `  ${plugin.manifest.displayName}`
          : "";
        console.log(
          `${pluginKey(plugin.manifest.pluginId, plugin.marketplace)}  ${plugin.manifest.version}${display}`,
        );
      }
      return;
    }
    if (args[0] === "install") {
      const pluginId = args[1];
      if (!pluginId) fail("Usage: baton plugins install <plugin-id> [--marketplace <name>]");
      await registry.refresh();
      const installed = registry.install(pluginId, {
        marketplace: argValue("--marketplace"),
      });
      settings.set({
        pluginId: installed.manifest.pluginId,
        marketplace: installed.provenance.marketplace,
        packageVersion: installed.manifest.version,
        enabled: true,
      });
      console.log(
        `${installed.alreadyInstalled ? "already installed" : "installed"} and enabled ${pluginKey(installed.manifest.pluginId, installed.provenance.marketplace)}  ${installed.manifest.version}`,
      );
      return;
    }
    if (args[0] === "list") {
      const installed = registry.installed();
      if (installed.length === 0) {
        console.log("(no Plugin Packages installed)");
        return;
      }
      const configured = new Map(settings.list().map((setting) => [setting.key, setting]));
      for (const plugin of installed) {
        const key = pluginKey(plugin.manifest.pluginId, plugin.provenance.marketplace);
        const setting = configured.get(key);
        console.log(
          `${key}  ${plugin.manifest.version}${setting ? `  ${setting.enabled ? "enabled" : "disabled"}` : ""}`,
        );
      }
      return;
    }
    fail(
      "Usage: baton plugins marketplace add|remove|list | available | install <plugin-id> | list",
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
