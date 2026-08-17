// 工具调用 effect（只读/副作用）的 adapter 侧判定 helper。
// kind 词汇能直接回答的走 kindEffect；execute 类必须看命令文本的走
// exploratoryShellCommand。判定宁可保守:错判 write 只是展示不聚合,
// 错判 read 会把有副作用的操作折叠进摘要组,审查面就丢了。
import type { ToolEffect } from "../event/index.ts";

/**
 * kind 词汇 → effect 的直接映射;execute/think/other 等回答不了读写,
 * 返回 undefined 由调用方用更具体的信息(命令文本、工具名)继续判。
 */
export function kindEffect(kind: string | undefined): ToolEffect | undefined {
  switch (kind) {
    case "read":
    case "search":
    case "fetch":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "write";
    default:
      return undefined;
  }
}

// 只读 shell 命令白名单。判定逻辑对齐 Codex TUI 的 Explored 规则(parse_command.rs),
// 另补 echo/pwd 等中性命令——harness 常用 `echo ---` 分隔多段探索输出,
// 缺了它们整条复合命令都进不了组。写工具(rm/cp/git/npm…)一律不在名单内,
// 未收录的命令保守视为有副作用。
const EXPLORATORY_SHELL_COMMANDS = new Set([
  // 读文件
  "cat", "bat", "batcat", "less", "more", "head", "tail", "awk", "nl", "sed",
  // 列目录/查元信息
  "ls", "eza", "exa", "tree", "du", "df", "fd", "find", "wc", "file", "stat",
  "readlink", "realpath", "basename", "dirname",
  // 搜索
  "rg", "rga", "grep", "egrep", "fgrep", "ag", "ack", "pt",
  // 中性:纯输出/查询,无文件或环境副作用
  "echo", "printf", "pwd", "which", "type", "date", "env", "printenv", "true",
]);

/**
 * 一条 shell 命令是否纯只读探索:按 `|`/`&&`/`||`/`;`/换行 拆段,每段的命令词
 * 都落在 EXPLORATORY_SHELL_COMMANDS 内才算。防线(方向都是宁漏勿错):
 * - 任何 stdout 重定向(`>`/`>>`;`2>`/`&>` 除外)都可能写文件 → false;
 * - `sed -i` 原地改文件、`find -delete/-exec/-ok` 可执行任意动作 → false;
 * - 空段跳过,但整条命令至少要有一个有效段;引号内的 `>` 会误伤,
 *   结果只是该命令不聚合,可接受。
 */
export function exploratoryShellCommand(command: string): boolean {
  if (/((?<![\d&])>{1,2})/.test(command)) return false;
  const segments = command.split(/&&|\|\||[;|\n]/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    // 跳过 `FOO=bar` 赋值与 sudo/command 前缀,取真正的命令词(容忍绝对路径)。
    while (
      tokens.length > 0 &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!) || tokens[0] === "sudo" || tokens[0] === "command")
    ) {
      tokens.shift();
    }
    const word = tokens[0]?.split("/").pop();
    if (!word || !EXPLORATORY_SHELL_COMMANDS.has(word)) return false;
    if (word === "sed" && tokens.some((t) => t.startsWith("-i"))) return false;
    if (word === "find" && tokens.some((t) => t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok")) {
      return false;
    }
    return true;
  });
}
