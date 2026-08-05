// TextGeneratable 的 codex 实现（见 src/harness/adapter.ts）：一次性 `codex exec`
// 子进程——--ephemeral 不写 rollout、read-only sandbox、结构化输出经 --output-schema /
// --output-last-message 临时文件交换。与 claude 侧同契约：旁路工具调用对真实会话零副作用。

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TextgenRequest } from "../adapter.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const STDERR_MAX_CHARS = 16_384;

export interface CodexTextgenOptions {
  /** app-server 启动命令；全局参数会保留，app-server 子命令会替换为 exec。 */
  command?: string[];
  /** 测试注入点：替代真实子进程，返回 exec 写进 --output-last-message 的内容。 */
  execFn?: (argv: string[], prompt: string, outputPath: string) => Promise<void>;
}

/** exec argv 构造（纯函数，测试锚点）：schema/output 文件路径由调用方分配。 */
export function codexExecArgs(request: TextgenRequest, schemaPath: string, outputPath: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    ...(request.model ? ["--model", request.model] : []),
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-", // prompt 走 stdin
  ];
}

/** 保留 codex 全局参数/包装器，只替换 app-server 子命令及其专用参数。 */
export function codexTextgenLaunch(command: readonly string[], execArgs: string[]): string[] {
  const appServerIndex = command.indexOf("app-server");
  if (appServerIndex < 1) {
    throw new Error("codexCommand must contain app-server to derive a textgen exec command");
  }
  return [...command.slice(0, appServerIndex), ...execArgs];
}

export async function generateCodexStructured(
  request: TextgenRequest,
  options: CodexTextgenOptions = {},
): Promise<unknown> {
  // mkdtempSync 已保证目录唯一，文件名无需再带随机部分。
  const dir = mkdtempSync(join(tmpdir(), "baton-textgen-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  try {
    writeFileSync(schemaPath, JSON.stringify(request.jsonSchema));
    const argv = codexExecArgs(request, schemaPath, outputPath);
    await (
      options.execFn ??
      ((a, p, o) => {
        const [binary, ...args] = codexTextgenLaunch(options.command ?? ["codex", "app-server"], a);
        return execCodex(binary as string, args, p, o, request);
      })
    )(argv, request.prompt, outputPath);
    return JSON.parse(readFileSync(outputPath, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function execCodex(
  binary: string,
  argv: string[],
  prompt: string,
  _outputPath: string,
  request: TextgenRequest,
): Promise<void> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: request.cwd,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_MAX_CHARS);
    });
    // 子进程可能在 stdin 写完前因 auth/config 退出；终态统一由 close 回调报告。
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`codex textgen timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`codex textgen failed (exit ${code}): ${stderr.trim()}`));
    });
    child.stdin.end(prompt);
  });
}
