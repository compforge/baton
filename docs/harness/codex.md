# Codex Harness Adapter

本文只描述 Codex 相对 [Harness 公共契约](../harness.md) 的协议差异、恢复策略和非显而易见的
取舍。端到端 Input/Event 时序以 [工作流](../workflow.md) 为准，具体 wire 字段以 Adapter 和
契约测试为事实来源。

## 1. 接入方式

Baton 启动 `codex app-server` 子进程，通过 stdin/stdout JSON-RPC 调用原生协议并接收通知与
server request。进程继承本机环境和 Codex 登录态；Baton 不读取、复制或存储 Codex 凭证。

启动顺序是：

```text
spawn app-server
  → initialize / initialized
  → hook trust preflight（支持时）
  → thread/resume 或 thread/start
  → publish HarnessSessionBinding
```

initialize 和 thread start/resume 属于 Turn 提交前的 setup，必须有显式 timeout；
`turn/start` 兼容可能阻塞到 Turn 结束的旧 app-server，不使用同一个启动 timeout。

## 2. Session 与恢复

Codex `thread.id` 是稳定 HarnessSession identity，也是 v1 resume state 的内容。打开时优先
`thread/resume`；原生 thread 明确不存在时新建 `thread/start`，随后由 Baton Context delivery
补齐逻辑历史。其他 resume 失败不能伪装成 not-found。

审批 reviewer 只有在用户显式配置时才传给 Codex。Baton 不从配置意图推断实际路由，而是读取
`thread/start|resume` 响应回吐的生效值；企业 policy 可能覆盖请求值。未知值返回 `null`，UI
不声称“用户审批”或“自动审批”。

## 3. 当前 Capability

| Capability | Codex 映射 |
|---|---|
| text prompt | `turn/start.input` / `turn/steer.input` |
| image prompt | path-backed block → `localImage`；base64 block → data URL `image` |
| compact | `thread/compact/start` |
| Context side-channel | `turn/start.additionalContext["baton-sync"]` |
| Session config | model、effort、collaboration mode 的原生目录与更新 |
| reconcile | `thread/read.status` |
| approval routing | `approvalsReviewer` 的实际生效值 |

当前不声明 audio、embedded resource 或 resource link；unsupported block 在 admission 前
明确报错，不能静默转成 text。

Context catch-up 使用 `turn/start.additionalContext`，使其作为 contextual fragment 与本 Turn
一起送达且不经过 UserPromptSubmit hook。不要改回独立 user message 注入：那会在 Codex 原生
rollout 中产生没有对应 Turn 的悬空用户消息，并污染正典历史。

## 4. Input 与控制映射

空闲时 `sendTurn` 发 `turn/start`。Controller 已经持久化原始 `user_message` 和 Baton running
开界，Adapter 只报告 Codex 执行产出与终态。

有活跃 Turn 时，只有 Baton turn ID 匹配且原生 Codex turn ID 已知，才发：

```text
turn/steer(threadId, expectedTurnId, input)
```

`expectedTurnId` 是 race 防线。原生拒绝、Turn 不匹配或 native ID 尚未返回时，Adapter 返回
`rejected`，由 Controller 排成 follow-up；不能向未知 Turn 注入，也不能并行 `turn/start`。

cancel 映射 `turn/interrupt`。fast-submit 窗口里原生 turn ID 可能尚未返回，Adapter 先记录
pending cancel，ID 就位后补发；Controller 的 cancel grace 仍负责最终兜底。

## 5. Interaction 与输出

Codex 的 permission、question 等 server request 由 Adapter 转成 `InteractionDraft`，等待 Baton
result 后再回原生协议。hook trust 是 thread 打开前的 setup Interaction：Baton 按 hook
精确定义保存信任指纹，定义变化后重新询问；已信任且未变化时显示可见 notice。

delegated reviewer 没有向 Baton 打开 Interaction 时，Adapter 把 review 终态归一为带独立
`reviewId` 的 `ApprovalReview` 审计事实。无 target 的 review 也必须留痕，未知 decision
fail closed，不能伪造成 permission requested/answered。

主要输出映射包括：

- item message/reasoning → agent message/thought；
- command/file/tool item → tool lifecycle、实时 output 和 DiffBlock；
- `turn/plan/updated` → plan snapshot；
- collab agent item → task lifecycle；
- token usage → usage/context snapshot；
- `turn/completed`、wire error、进程退出 → Turn 终态。

`turn/start` 响应和 `turn/completed` 通知可能竞速；Adapter 只允许所属 `CodexTurn` 第一次逻辑
终结生效。completed 但没有任何可见产出时发空回合 warning，避免 hook 拦截等路径表现为
“成功但吞消息”。

## 6. Stall 对账

Codex 声明 `reconcile`，通过 `thread/read { includeTurns:false }` 查询 live `thread.status`：

- idle → Harness 已结束但 Baton 漏终态，可以走自愈收口；
- active → 仍在执行；
- waitingOnApproval / waitingOnUserInput → 保留相应等待状态；
- 未知值 → `unknown`，不自动 finalize。

对账只信 live status，不用 rollout items 猜运行态；历史 items 可能和已丢事件一样陈旧。

## 7. 外部 Session Inspector

只读 Inspector 使用独立 app-server：

1. `thread/read` 验证 identity、cwd 和标题；
2. `thread/turns/list` 分页读取 `itemsView:"full"`；
3. 用与 live Adapter 相同的 item mapping 生成完整 Baton Turn；
4. 计算覆盖完整语义前缀的 `HarnessHistoryBoundary`。

发现 in-progress Turn 或非 full history view 时 fail closed，不能把不完整前缀 adoption 为
BatonSession。Inspector 结束后关闭临时 app-server，不修改原生 thread。

## 8. 代码与测试锚点

- `src/harness/codex/adapter.ts` — live Adapter、Interaction、Capability 和 mapping
- `src/harness/codex/jsonrpc.ts` — JSON-RPC transport
- `src/harness/codex/native-session.ts` — 只读历史 Inspector
- `tests/codex-session.test.ts`、`tests/codex-steer.test.ts` — Session 与 steer
- `tests/codex-turn-race.test.ts`、`tests/codex-empty-turn.test.ts` — 终态竞速与空回合
- `tests/reconcile.test.ts`、`tests/approval-contract.test.ts` — 对账与审批诚实性
