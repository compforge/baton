# Plugin Reconcile Context

## 理念与边界

Plugin Controller 每次 reconcile 都会收到一个 `ReconcileContext`。其中 `snapshot`
是当前 BatonSession 的冻结只读视图，`ask`、`confirm`、`withdraw`、`draft`、`harness` 是宿主
提供的控制能力。Plugin 负责领域判断与操作顺序；Baton Core 负责 Interaction、
授权、执行调度、Event Ledger、幂等、恢复和结果回传。Plugin 因而能表达完整
loop，但不能持有 Harness Adapter、进程、SDK 句柄或跨 reconcile 的内存 continuation。

这些能力分成人机决议和 Harness 执行两组：

- `ask`、`confirm` 请求人的决定，并把问题、deadline 与结果持久化为 Interaction；`withdraw`
  在领域流程不再需要某次决定时撤回未决 Interaction；
- `draft`、`harness` 请求一个 Harness Turn。前者先让用户编辑，后者直接执行。

一次调用立即返回当前持久状态。未决 `ask` 返回 `waiting`，未完成执行返回 `editing` 或
`pending`；Core 在对应 ledger 事实变化后重新 enqueue 原 Resource，下一次 reconcile 用同一个
`key` 读取答案或结果。`await` 只统一异步调用形式，不会让 Runner 跨人的等待长期挂住 Promise。

## 编排流程

Plugin 可以通过 `ctx.snapshot` 读取当前事实，再把领域动作写成普通控制流：

```ts
const decision = await ctx.ask({
  key: "handle-review:run-17",
  title: "Handle AI review comments",
  prompt: "How should Baton handle these findings?",
  choices: [
    { value: "run", label: "Run now" },
    { value: "edit", label: "Edit first" },
    { value: "ignore", label: "Ignore" },
  ],
});
if (decision.state !== "answered") return;

const execution = decision.value === "edit"
  ? await ctx.draft({ key: "review:draft", prompt })
  : await ctx.harness({
      key: "review:run",
      prompt,
      laneId: "main",
      newLane: true,
    });
if (execution.state !== "completed") return;

await resources.patchStatus(resource, {
  handledTurnId: execution.turn.turnId,
});
```

`ask` / `confirm` 可以携带从 Resource 或外部事实读取的稳定 `expiresAt`。deadline 是绝对时间，
随 Interaction 一起持久化；到期后 Core 先记录 `cancelled(timeout)`，再重新 enqueue Resource。
Plugin 决定 timeout 在自己的领域里表示拒绝、跳过还是转人工，Core 不把它自动改写为某个答案。
不能在每次 reconcile 时用当前时间重新计算同一 key 的 deadline；要延长期限或重新询问时使用新 key。

当领域条件变化、不再需要用户回答时，Plugin 显式撤回原 operation：

```ts
await ctx.withdraw({ kind: "ask", key: "handle-review:run-17" });
```

撤回只结束仍未决的 Interaction，并持久化 `cancelled(requester)`；若用户答案或其它终态已经先到，
返回 `not-pending`，原 `ask` / `confirm` 仍可用同一 key 读取已经成立的结果。

需要人的动作显式组合 `ask` 或 `confirm`。无需编辑或授权的 Core 辅助工作可以直接调用
`harness`；需要用户调整的内容直接调用 `draft`。Baton 不从 Plugin 名称、业务类型或
“前台/后台”标签猜执行方式。

## Lane、source 与执行记录

`harness` 用两个参数选择执行位置：

- `laneId` 是一个已存在的 Lane；`main` 是 BatonSession 主 Lane 的保留 ID；
- `newLane` 缺省为 `false`，表示继续 `laneId`；设为 `true` 时从该 Lane 创建支线。

Lane 不表示发起者、优先级、UI 位置、worktree 或是否调用 Harness。`draft` 提交后的 Input source
是 user，`harness` 产生的 Input source 是 Plugin；source 与 Lane 是两条正交轴。结果中的 `laneId`
始终是实际执行 Lane，可传给后续 `harness` 调用以继续同一支线。

Core 为每次 `draft` / `harness` 持久化 `HarnessInvocation`。它是能力调用的执行记录，不是 Plugin
API，也不承担人机授权语义。记录绑定 Plugin、Resource UID、operation key、prompt、Target、
delivery、请求的 `laneId + newLane`，随后关联实际 Lane、Input、Delivery Attempt、Turn 和
TurnSummary。新 Lane 的 `createdFor` 与 `parentLaneId` 只记录创建事实，不是后续调用的所有权约束。

## 身份、恢复与取消

同一 Resource incarnation 内，调用的 `key` 是逻辑操作的幂等键。同一个 key 的参数不可变；需要
再次提问或再次执行时使用新 key。Core 先记录意图再执行副作用，并从 ledger 派生当前状态：

- `ask/confirm` 重放同一 Interaction，答案落盘后再唤醒 Resource；
- `expiresAt` 到期和 `withdraw` 都先落取消事实，再唤醒或继续当前 Resource；
- `draft` 在用户提交最终 Prompt blocks 前不创建 Input；
- `harness` 只调度一次稳定的 message、turn 和 lane identity；
- 已 accepted 但结果不明的投递保持 `uncertain`，恢复时先对账而非盲目重投；
- TurnSummary 到达后，下一次 reconcile 得到 `completed` 及完整 summary。

Interaction 的回答、超时和撤回遵守 first-terminal-wins；Resource 物理删除时，仍未决的关联
Interaction 以 `requester` 原因收口。Harness 执行取消则按 HarnessInvocation identity 定向处理自己的
queued Input 或 driven Turn，不影响其它 Lane。
普通 composer recall 只处理用户输入，不撤回 Plugin 执行记录。
