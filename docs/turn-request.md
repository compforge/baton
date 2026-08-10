# TurnRequest：受控发起一个新 Turn

## 1. 理念与边界

`TurnRequest` 是 Baton 在直接 user Input 之外，接受控制面主体发起一个新 driven Turn 的持久
意图。它表达“由谁、为何请求创建 Turn”，不是对 Harness Work 的抽象；Harness 只是 Turn 被准入
后选中的执行端。当前首个公开 producer 是 Plugin Resource Controller，它在后续 reconcile 中
读取结果；一个 Request 最多关联一个新 Turn，长期 loop 通过多次 reconcile 产生多个 Request。

获批的 TurnRequest 会物化为带发起方来源的 Input，再进入统一执行链：

```text
User ───────────────────────────────→ user-source Input ┐
Plugin → TurnRequest → authorization → plugin-source Input ├→ admission → Attempt → Turn → Harness
```

Baton 继续拥有用户授权、Harness 路由、Input admission、并发、取消、Context、Delivery
Attempt、Turn 和结果持久化。Plugin 不能持有 Harness Adapter、进程或 SDK 句柄。

`TurnRequest` 不复用 `proposed-input`：后者是交给用户编辑并最终提交的输入建议；前者由 Plugin
发起，用户只决定是否授权。批准后的 prompt 不进入 composer，也不能被编辑后冒充原请求。

## 2. 公共契约

当前 Plugin Controller 通过受控 Output 发起请求：

```ts
interface TurnRequestOutput {
  readonly kind: "turn-request";
  /** 同一 Resource 内一次逻辑请求的幂等键；重新执行必须更换。 */
  readonly requestKey: string;
  readonly title: string;
  readonly description?: string;
  readonly prompt: string;
  /** 缺省时在授权通过时固化 Baton 当前选择的 HarnessTarget。 */
  readonly harnessTargetId?: string;
}
```

当前 reconcile Resource 只能看到自己发起的请求：

```ts
interface TurnRequestSnapshot {
  readonly requestId: string;
  readonly requestKey: string;
  readonly resource: ResourceRef;
  readonly phase:
    | "pending_approval"
    | "declined"
    | "queued"
    | "running"
    | "uncertain"
    | "completed"
    | "cancelled";
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly turnId?: string;
  readonly result?: TurnSummary;
}
```

`completed` 表示 Request 已经产生 Turn 且 Turn 已收口，不代表领域验收成功；Harness error、拒绝
或执行中 Esc 也通过 `result.stopReason` 表达。`cancelled` 只表示 Request 在 Input admission 前被
取消，因此没有执行结果。

## 3. Input 来源

Input 显式记录发起方：

```ts
type InputSource =
  | { type: "user" }
  | {
      type: "plugin";
      pluginInstanceId: string;
      turnRequestId: string;
    };
```

composer、用户确认的 `proposed-input` 和用户实施 ProposedPlan 都是 user source；ProposedPlan ID
仍是独立因果关联。当前 Plugin 发起的 TurnRequest 物化为 plugin source。cron、Watch 和 Source
只唤醒 reconcile，不是 Input source；observed Turn 与 control Turn 没有 Input。

Input 开界时，`user_message` Event source 从 Input source 派生，不再写死为 user。事件 kind 表示
Harness 看到的 user-role message，Event source 表示谁实际发起，两者正交。Plugin prompt 执行后
在 timeline 中按 Plugin 来源标注，保证内容可审计。

## 4. 主流程

```text
Resource reconcile
  → turn-request Output
  → durable TurnRequest
  → permission Interaction
  → Allow once / Reject
  → plugin-source Input
  → Delivery Attempt
  → driven Turn / Event Ledger
  → TurnSummary
  → enqueue original Resource
  → reconcile reads TurnRequestSnapshot.result
```

授权复用 Interaction 的持久生命周期和 TUI surface；Interaction 记录外部参与者的答案，
TurnRequest authorization fact 记录 Baton 是否接管请求。将来自动授权策略可以直接产生同类决议，
不伪造用户 Interaction。

授权卡展示 Plugin、title、description、目标 Harness 和可展开查看但不可编辑的 prompt。显式
`harnessTargetId` 始终展示并使用该 Target；缺省 Target 在卡片中动态跟随当前选择，并在用户批准
时固化，确保“看到并批准的 Target”就是实际执行 Target。

Allow 后先固化 Target，预签发 `laneId/messageId/turnId` 并持久化 scheduled fact，再把 Input 放入
支线队列。TurnRequest 的语义就是请求一个 new Turn：它不能 steer 到主 Lane 的当前 Turn；调用
Harness 是 Input 准入后的下游行为，不是 Request 自己执行 Harness Work。

每个 Request 当前会创建一个 `createdFor:turn_request` Lane，Lane identity 在原生 Session 重建后
仍保持不变。它是 BatonSession 原生支线，不是 TurnRequest 私有执行模型：同一 Lane 可以在后续 Turn
切换 HarnessTarget，人发起异步任务时也复用 Lane。多个支线可在并发上限内同时运行；主 Lane 使用
独立队列，因此用户继续提交、steer 或 Esc 都不等待支线。模型、effort 和 mode 偏好按 Target
共享，Binding、HarnessSession、Attempt、ContextEpoch 和执行投影按 `Lane × HarnessTarget` 隔离。

Lane 只表达任务的串行与并发边界，不拥有 workspace，也不创建或管理 Git worktree。代码写入隔离
由 Harness 内的 devloop 等 Plugin 负责；Baton 不把某一种版本控制或文件视图策略带入通用编排层。

批准并排队、Attempt 进入 `uncertain`、以及请求终结时都会唤醒原 Resource。Plugin 读取 Snapshot
推进领域状态，不能因 `uncertain` 生成新 requestKey 或重投。

## 5. 身份、冲突与事实

`requestId` 由 BatonSession、PluginInstance、Resource UID 和 `requestKey` 确定性生成。同一身份
下 title、description、prompt 和目标都不可变：完全相同则幂等复用；任一字段变化则本次 reconcile
以明确的 identity conflict 失败，不记录新事实、不重新授权，沿用 Controller 的错误与退避路径。
重新执行必须更换 `requestKey`。

TurnRequest 控制事实进入 BatonSession Event Ledger：

- `_baton_turn_request_recorded`：绑定 Resource、requestKey、授权展示和实际 prompt；
- `_baton_turn_request_authorization_resolved`：记录 allow/decline、实际 Target 和决策来源；
- `_baton_turn_request_scheduled`：记录 Input 的 Lane、messageId、turnId 和 HarnessTarget；
- `_baton_turn_request_cancelled`：记录 admission 前取消及原因。

结果不复制到 Request Event，始终由对应 `_baton_turn_summary` 派生。phase 同样只从授权、Input、
Delivery Attempt、TurnSummary 和取消事实派生，不另建可写状态机。

所有支线 Event 仍 append 到同一 BatonSession ledger，并携带 `laneId`。`seq` 只表示 append
顺序，不表达跨 Lane 因果。默认 timeline 隐藏 TurnRequest 支线的逐条 message/tool/plan，只保留一张
TurnRequest 卡片；卡片展示 phase、Lane 和完成摘要，原始 transcript 可按 Lane 回查。

## 6. 取消与恢复

授权卡上的 Reject 产生 `declined`。批准后，用户可用 `/cancel-request [requestId]` 取消指定请求；
缺省取消最近一个可取消的 TurnRequest。queued Request 被移出支线 InputQueue 并进入
`cancelled`；已经 admitted 的 Request 只 interrupt 自己的支线 Lane，最终进入 `completed`，
成败由 TurnSummary 表达。Esc 只控制主 Lane，不误伤支线。

composer 的 ↑ recall 只撤回最新的 user-source queued Input，不能误撤 Plugin Input。Resource
incarnation 消失时，尚未 admitted 的请求进入 `cancelled`；已开始的 Turn 仍按正常终态收口。

恢复按持久事实补齐缺口：

- 只有 recorded：重新打开授权 Interaction；
- authorization 已记录但 Interaction 尚未关闭：按授权事实补记 resolved；
- 已 allow 但缺 scheduled：按已固化 Target 预签发 identity；
- 已 scheduled 但没有 `user_message`：恢复同一 Lane，并用原 identity 重建 Input；
- 已有 `user_message` 或 Attempt：不重复提交；正确写入顺序始终先记 authorization 再关闭
  Interaction，恢复不会猜测一个未持久化的隐式 Target；
- Attempt 为 `uncertain`：先对账，不自动重投；
- 已有 TurnSummary：投影 `completed` 并重新 reconcile Resource。

## 7. 验收边界

契约测试必须锁住：requestKey 幂等与冲突、Resource UID 隔离、授权 Target 诚实、Allow/Reject、
Input source 全链路、支线不阻塞主线、同 Target 多 Lane 隔离、Lane 跨 Target 接力、并发上限、busy 时不 steer、
user recall 不撤 Plugin Input、Esc/Request 定向取消、崩溃窗口
恢复不重复执行、`uncertain` 不重投、支线卡片隐藏原始流，以及 TurnSummary 落盘后原 Resource
获得准确结果。
