import type { HookTrustCandidate } from "../../interaction/types.ts";

/**
 * 审批路由**不由 baton 定默认**：`thread/start` 原生收 `approvalsReviewer`，缺省
 * （undefined）就交给 codex 自己解析——config.toml、profile、企业 requirements 全部照常
 * 生效，baton 与 codex 天然一致。codex 自己的默认是 `user`（且 guardian feature 开着
 * 也不变），baton 没有比上游更激进的理由。用户显式配了才传，作为 opt-in 委托。
 *
 * 曾经的做法是往 argv 注入 `-c approvals_reviewer=...`：既覆盖了用户的 codex 配置，
 * 又反推不出生效值——企业 requirements（allowed_approvals_reviewers）能把注入的值打回，
 * 让 footer 撒谎。生效值只认 thread/start|resume 响应的回吐（见 approvalRoute）。
 */
export function codexLaunchCommand(command?: string[]): string[] {
  return command && command.length > 0 ? [...command] : ["codex", "app-server"];
}

const HOOK_TRUST_BYPASS_FLAG = "--dangerously-bypass-hook-trust";

/** 只有可识别的 app-server argv 才能安全做 hook trust preflight / 重启。 */
export function codexSupportsHookTrustPreflight(command: string[]): boolean {
  return command.includes("app-server") && !command.includes(HOOK_TRUST_BYPASS_FLAG);
}

/** Codex 的 bypass 是全局 flag，必须放在 app-server 子命令之前。 */
export function codexCommandWithHookTrustBypass(command: string[]): string[] {
  const index = command.indexOf("app-server");
  if (index < 0) throw new Error("Codex hook trust requires an app-server command");
  if (command.includes(HOOK_TRUST_BYPASS_FLAG)) return [...command];
  return [...command.slice(0, index), HOOK_TRUST_BYPASS_FLAG, ...command.slice(index)];
}

/** hooks/list wire DTO 只停留在 adapter 边界，向内归一成稳定的 trust candidate。 */
export function codexHooksRequiringTrust(result: unknown): HookTrustCandidate[] {
  const rows = (result as { data?: unknown[] })?.data;
  if (!Array.isArray(rows)) return [];
  const candidates = new Map<string, HookTrustCandidate>();
  for (const rawRow of rows) {
    const hooks = (rawRow as { hooks?: unknown[] })?.hooks;
    if (!Array.isArray(hooks)) continue;
    for (const rawHook of hooks) {
      const hook = (rawHook ?? {}) as Record<string, unknown>;
      const trustStatus = hook.trustStatus;
      if (hook.enabled === false || (trustStatus !== "untrusted" && trustStatus !== "modified")) continue;
      const key = String(hook.key ?? "").trim();
      if (!key || candidates.has(key)) continue;
      candidates.set(key, {
        key,
        source: String(hook.source ?? "unknown"),
        sourcePath: String(hook.sourcePath ?? ""),
        trustStatus,
        command: String(hook.command ?? ""),
        matcher: hook.matcher == null ? undefined : String(hook.matcher),
        pluginId: hook.pluginId == null ? undefined : String(hook.pluginId),
        currentHash: hook.currentHash == null ? undefined : String(hook.currentHash),
        handlerType: hook.handlerType == null ? undefined : String(hook.handlerType),
        timeoutSec: typeof hook.timeoutSec === "number" ? hook.timeoutSec : undefined,
        statusMessage: hook.statusMessage == null ? undefined : String(hook.statusMessage),
      });
    }
  }
  return [...candidates.values()];
}

/** Trust 仍逐 hook 校验；这里只按 owner 聚合启动通知，避免同一插件的多条 hook 刷屏。 */
export function summarizeTrustedHookOwners(hooks: HookTrustCandidate[]): string {
  const owners = new Map<string, number>();
  for (const hook of hooks) {
    const owner = hook.pluginId || hook.sourcePath || hook.key;
    owners.set(owner, (owners.get(owner) ?? 0) + 1);
  }
  return [...owners].map(([owner, count]) => (count === 1 ? owner : `${owner} (${count} hooks)`)).join("\n");
}

