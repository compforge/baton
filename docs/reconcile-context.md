# Plugin Reconcile Context

## 理念与边界

Plugin Controller 每次 reconcile 都会收到一个 `ReconcileContext`。其中 `snapshot`
是当前 BatonSession 的冻结只读视图，`ask`、`confirm`、`draft`、`harness` 是宿主
提供的控制能力。Plugin 负责领域判断与操作顺序；Baton Core 负责 Interaction、
授权、执行调度、Event Ledger、幂等、恢复和结果回传。Plugin 因而能表达完整
loop，但不能持有 Harness Adapter、进程、SDK 句柄或跨 reconcile 的内存 continuation。

这些能力分成两组：

- `ask`、`confirm` 请求人的决定，并把问题与答案持久化为 Interaction；
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
  : await ctx.harness({ key: "review:run", prompt, lane: "new" });
if (execution.state !== "completed") return;

await resources.patchStatus(resource, {
  handledTurnId: execution.turn.turnId,
});
```

需要人的动作显式组合 `ask` 或 `confirm`。无需编辑或授权的 Core 辅助工作可以直接调用
`harness`；需要用户调整的内容直接调用 `draft`。Baton 不从 Plugin 名称、业务类型或
“前台/后台”标签猜执行方式。

## Lane、source 与执行记录

`harness` 的 `lane` 只选择执行位置：

- `main` 进入 BatonSession 主 Lane，与主任务串行；
- `new` 创建支线 Lane，可与主 Lane 并行，Lane 内仍然串行。

Lane 不表示发起者、优先级、UI 位置、worktree 或是否调用 Harness。`draft` 提交后的 Input source
是 user，`harness` 产生的 Input source 是 Plugin；source 与 lane 是两条正交轴。

Core 为每次 `draft` / `harness` 持久化 `HarnessInvocation`。它是能力调用的执行记录，不是 Plugin
API，也不承担人机授权语义。记录绑定 Plugin、Resource UID、operation key、prompt、Target、
delivery 与 lane，随后关联 Input、Delivery Attempt、Turn 和 TurnSummary。`new` Lane 的
`createdFor` 只记录该 invocation 的创建事实。

## 身份、恢复与取消

同一 Resource incarnation 内，调用的 `key` 是逻辑操作的幂等键。同一个 key 的参数不可变；需要
再次提问或再次执行时使用新 key。Core 先记录意图再执行副作用，并从 ledger 派生当前状态：

- `ask/confirm` 重放同一 Interaction，答案落盘后再唤醒 Resource；
- `draft` 在用户提交最终 Prompt blocks 前不创建 Input；
- `harness` 只调度一次稳定的 message、turn 和 lane identity；
- 已 accepted 但结果不明的投递保持 `uncertain`，恢复时先对账而非盲目重投；
- TurnSummary 到达后，下一次 reconcile 得到 `completed` 及完整 summary。

取消按 HarnessInvocation identity 定向处理自己的 queued Input 或 driven Turn，不影响其它 Lane。
普通 composer recall 只处理用户输入，不撤回 Plugin 执行记录。
