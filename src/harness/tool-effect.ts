// 工具调用 effect（只读/副作用）的 adapter 侧判定 helper。
// 这里只处理语义已经由 Harness 明确归一的 kind；shell 文本不能可靠证明
// 无副作用，execute/think/other 等保持 unknown，由消费方保守处理。
import type { ToolEffect } from "../event/index.ts";

/**
 * kind 词汇 → effect 的直接映射；execute/think/other 等回答不了读写时返回 undefined。
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
