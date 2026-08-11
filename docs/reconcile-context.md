# Plugin Reconcile Context

## 理念与边界

Plugin Controller 每次 reconcile 都会收到一个 `ReconcileContext`。其中 `snapshot`
是当前 BatonSession 的冻结只读视图，`ask`、`confirm`、`withdraw`、`draft`、`harness` 是宿主
提供的控制能力。Plugin 负责领域判断与操作顺序；Baton Core 负责 Interaction、
授权、执行调度、Event Ledger、幂等、恢复和结果回传。Plugin 因而能表达完整
loop，但不能持有 Harness Adapter、进程、SDK 句柄或跨 reconcile 的内存 continuation。

`ask/confirm/draft/harness` 都先经过 Core-owned Interaction，只是决议方式不同：

- `ask`、`confirm` 请求人的决定，并把问题、deadline 与结果持久化为 Interaction；`withdraw`
  在领域流程不再需要某次决定时撤回未决 Interaction；
- `draft` 先打开 suggested-input Interaction，由用户编辑或关闭；
- `harness` 先打开 Harness gate Interaction。策略可以自动批准，也可以要求用户确认。

只有 suggested input 已提交或 Harness gate 已批准，Core 才创建代表实际执行的
`HarnessInvocation`。即使当前策略自动批准，requested/answered 事实也必须先落 ledger，不能绕过
Interaction；这条边界为后续权限、风控和宿主拦截保留稳定接入点。
Harness gate 会固化最终选择的 HarnessTarget、`laneId` 与 `newLane`；同一 operation ref 不能在
等待或批准后悄悄切换执行坐标。

一次调用立即返回当前持久状态。未决 `ask` 返回 `waiting`，未完成执行返回 `editing` 或
`pending`；Core 在对应 ledger 事实变化后重新 enqueue 原 Resource，下一次 reconcile 用同一个
`key` 读取答案或结果。`await` 只统一异步调用形式，不会让 Runner 跨人的等待长期挂住 Promise。

## 编排流程

Plugin 可以通过 `ctx.snapshot` 读取当前事实，再把领域动作写成普通控制流：

```ts
const reviewRunId = resource.status.reviewRunId;
if (!reviewRunId) return;
const operationKey = `handle-review:${reviewRunId}`;

const decision = await ctx.ask({
  key: operationKey,
  title: "Handle AI review comments",
  prompt: "How should Baton handle these findings?",
  choices: [
    { value: "run", label: "Run now" },
    { value: "edit", label: "Edit first" },
  ],
});
if (decision.state !== "answered") return;

const execution = decision.value === "edit"
  ? await ctx.draft({ key: operationKey, prompt })
  : await ctx.harness({
      key: operationKey,
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
`choices[].value` 是随 Interaction 持久化并最终返回给 Plugin 的稳定答案值；`label` 和
`description` 只负责展示，不参与领域判断。

当领域条件变化、不再需要用户回答时，Plugin 显式撤回原 operation：

```ts
await ctx.withdraw({ verb: "ask", key: operationKey });
```

撤回只结束仍未决的 Interaction，并持久化 `cancelled(requester)`；若用户答案或其它终态已经先到，
返回 `not-pending`，原 `ask` / `confirm` 仍可用同一 key 读取已经成立的结果。

需要领域选择时显式组合 `ask` 或 `confirm`；需要用户调整内容时调用 `draft`；已有完整 prompt
时调用 `harness`。三者都不绕过 Interaction。`harness` 的 gate 是否由策略自动批准或交给用户，
由宿主策略决定，而不是 Plugin 名称、业务类型或“前台/后台”标签决定。

## Lane、source 与执行记录

`harness` 用两个参数选择执行位置：

- `laneId` 是一个已存在的 Lane；`main` 是 BatonSession 主 Lane 的保留 ID；
- `newLane` 缺省为 `false`，表示继续 `laneId`；设为 `true` 时从该 Lane 创建支线。

Lane 不表示发起者、优先级、UI 位置、worktree 或是否调用 Harness。`draft` 提交后的 Input source
是 user，`harness` 产生的 Input source 是 Plugin；source 与 Lane 是两条正交轴。结果中的 `laneId`
始终是实际执行 Lane，可传给后续 `harness` 调用以继续同一支线。

`draft` 显式携带 `harnessTargetId` 时，suggested-input Interaction 固化并展示该 Target；省略时不在
创建 Interaction 时读取默认值，而是在用户提交编辑结果后读取宿主的当前选择。`harness` 没有编辑
等待阶段，省略 Target 时在创建 gate Interaction 前立即解析并固化宿主当前选择。

Core 在 `draft` 的 suggested input 已提交、或 `harness` 的 gate 已批准后，才持久化
`HarnessInvocation`。它是实际执行记录，不是 Plugin API，也不承担人机授权语义。记录绑定
Plugin、Resource UID、operation ref、最终 prompt、最终 Target、请求的 `laneId + newLane`，随后关联
实际 Lane、Input、Delivery Attempt、Turn 和
TurnSummary。新 Lane 的 `createdFor` 与 `parentLaneId` 只记录创建事实，不是后续调用的所有权约束。

## 身份、恢复与取消

Plugin 必须在每次 reconcile 中，从 Resource 持久化的 `spec/status` 或可重新观测的稳定外部事实，
确定性地重建下一步 operation ref（`verb + key`）及其编排顺序；不能依赖进程内存、随机值或当前
时间。否则 Core 会把变化后的 ref 视为新 operation，已持久化的结果将无法接回。

同一 Resource incarnation 内，完整操作身份是 `verb + key`。`key` 在各 verb 内是幂等键；同一
operation ref 的参数不可变，不同 verb 可以复用同一个 caller key。需要再次提问或再次执行时使用
新 key。Core 先记录意图再执行副作用，并从 ledger 派生当前状态：

- `ask/confirm` 重放同一 Interaction，答案落盘后再唤醒 Resource；
- `expiresAt` 到期和 `withdraw` 都先落取消事实，再唤醒或继续当前 Resource；
- `draft` 在用户提交最终 Prompt blocks 前不创建 HarnessInvocation 或 Input；
- `harness` 无论自动批准还是等待用户，都先持久化 Interaction；批准后只创建并调度一次稳定的
  HarnessInvocation、message、turn 和 lane identity；
- 已 accepted 但结果不明的投递保持 `uncertain`，恢复时先对账而非盲目重投；
- TurnSummary 到达后，下一次 reconcile 得到 `completed` 及完整 summary；
- 用户关闭尚未提交的 draft Interaction 才返回 `dismissed`，且不会产生 HarnessInvocation；
  Harness gate 等待时返回 `waiting`，拒绝时返回 `declined`；主动取消返回带封闭原因的 `cancelled`，
  admission 前的调度异常返回 `failed(dispatch)`，诊断文本只放在 `detail`。

HarnessInvocation 的终态会永久绑定当前 operation ref。Plugin 应按 `cancelled.reason` 或
`failed.reason` 决定领域策略；需要在失败后重新执行时使用新 key，不能解析 `detail` 或用同一 key
覆盖既有终态。

Interaction 的回答、超时和撤回遵守 first-terminal-wins；Resource 物理删除时，仍未决的关联
Interaction 以 `requester` 原因收口。Harness 执行取消则按 HarnessInvocation identity 定向处理自己的
queued Input 或 driven Turn，不影响其它 Lane。
普通 composer recall 只处理用户输入，不撤回 Plugin 执行记录。
