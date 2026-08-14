# Baton 工作流

本文是 Baton 三方协作工作流的唯一入口：Human Input、Harness 原生 verb 与 Plugin reconcile
verb 如何在 Core 汇合，HarnessInput/HarnessInvocation 如何到达 Harness，Harness 输出如何成为可恢复事实，
以及 steer、Interaction、cancel、失败和恢复如何复用同一条主路径。核心对象和不变量见 [Kernel](./kernel.md)，Adapter 契约见
[Harness](./harness.md)。

## 1. 三方通过 typed Core objects 协作

```text
Human  ─ submit ────────────────────────────────→ Input ───────────────→ Harness
Harness ─ native permission/question verb ─────→ Adapter lowering ─┐
Plugin  ─ ask/confirm reconcile verb ──────────→ Host lowering ────┴─→ Interaction ─→ Human
Plugin  ─ draft/harness reconcile verb ─→ Interaction gate ─→ HarnessInvocation ─→ Input ─→ Harness
Harness ─ native output ─→ Adapter normalize ─→ Event / Projection ─→ Channel outbound ─→ Human
                                                    └─ Hook ─→ Plugin
```

Harness 和 Plugin 都先表达自己边界内的 verb，再由了解两侧的 Adapter/host lowering 成 Core
对象。Core 不接收任意 message：Interaction 承载 typed decision gate，决议者可以是人，也可以是
宿主 policy；HarnessInvocation 只承载 gate 通过后的受控执行，Input 只承载已准备向 Harness 投递的工作。

Plugin 不另开执行通道。需要用户决定时调用 `ask` / `confirm`；需要用户修改 prompt 时调用
`draft`；已有完整 prompt 时调用 `harness`。所有发起新动作的 Plugin verb 都先物化为 Interaction；`harness`
即使被策略自动批准，也必须先落 requested/answered，再创建 HarnessInvocation。ledger 变化后 Core
恢复当前 Plugin execution continuation。Interaction 不进入 prompt queue，而是按稳定 identity
就地解开等待方。

## 2. Input 到 Harness

### 2.1 采集与准入

chat-tui 把键盘、文本和页面操作翻译成 Human Input，再交给 Core `Channel`。Input 是判别联合：
prompt、command、configuration、Interaction response 和 interrupt 都是输入事实；只有一部分会 lowering 为 HarnessInput，另一部分
操作 Core 的 Queue、配置或 Interaction。
mention、Session 引用和 Plugin Context 在 Context 层解析；chat-tui 不理解 HarnessSession 或
Harness wire。

Event Ledger 只记录 intake 的 WAL。Channel 让 BatonSession 先 record 并 reduce
`input.received(inputId, input)`，再以这条 durable record 通知
`human.inbound.before`，随后按 Input variant 调用 Controller、Interaction gateway 或具体配置 owner；owner 接受后先记录
`input.settled(outcome)`，再通知 `human.inbound.after`。Hook 即使通过 Verb 发起动作，也一定能找到
触发它的原始 Input。Hook 失败或超时 fail-open，不能阻塞用户继续输入。

Channel dispatch receipt 只说明 Input 已完成同步校验并被对应 owner 接受，不等于 Turn 已完成。prompt 的
Controller receipt 会继续暴露 Queue/Turn settlement；调用方可以选择等待，也可以只观察 Event/Projection。
Channel intake 不为完整 Harness Turn 保留一条阻塞调用链。

剪贴板图片由 Baton 壳层在显式 paste 时读取，按内容寻址归档到 Baton attachment store，并在
composer 中插入可编辑占位符；提交时占位符恢复为 path-backed `image` block。Event Ledger 只保存
稳定路径而不内联大段 base64，Adapter 再按 Harness 原生协议 lowering。文本 paste 仍由普通
composer 输入路径处理。

prompt lowering 时，Controller 创建 HarnessInput，为它分配稳定 `messageId` 并为可能的新 Turn
预留 `turnId`，再把它放入目标 Lane 的 Queue。每次 Queue 状态迁移都先 record
`harness_input.updated`，再更新内存执行索引；
`input.received` 通过 `parentEventId` 与第一个 HarnessInput 事实关联，两个对象不复用 identity。
若 Adapter 接受 steer，HarnessInput 改为绑定实际承载它的当前 Turn。即使队列停留极短，也遵守同一状态机：

```text
Enter
  │ create HarnessInput(messageId, reserved turnId)
  ▼
queued ── ↑ recall latest user Input ─────────────────────────────→ recalled
  │
  ├─ Lane idle / dequeue ─────────→ admitted ── Turn completes ──→ finalized
  │                                     └────── Esc / cancel ─────→ interrupted
  │
  └─ active steerable Turn / claim head ─→ dispatching
                                                │
                    Adapter accepts steer ──────┼→ accepted_steer
                                                │       ├─ Turn completes ─→ finalized
                                                │       └─ Esc / cancel ───→ interrupted
                    Adapter rejects / throws ───┴→ queued (same messageId, queue head)
```

`dispatching` 表示 Controller 已原子 claim 该 HarnessInput 并正在等待 same-turn Adapter admission；此时
不再允许 recall。Adapter 拒绝后，同一个 `messageId` 回到队头并降级为 follow-up，不能重建成另一条
HarnessInput。`queued` 输入仍可 recall。出队成为 `admitted` 后，用户消息已经是 BatonSession 的正典事实，
不能再伪装成“从未提交”；此后只能 cancel/interrupt。Controller 按 `laneId` 调度，而不按
HarnessInput source 调度：

- `laneId` 指定要继续的既有 Lane；保留值 `main` 表示主线；
- `newLane:true` 从 `laneId` 指向的既有 Lane 创建支线，受支线并发上限约束，不占用主 Lane
  Queue 的执行位；缺省 `false`，直接继续该 Lane。

Lane 是 Baton 原生的任务串并行边界，不代表谁发起，也不代表是否调用 Harness。人或 Plugin
发起的异步任务都可以使用新 Lane。每条 Lane 只有一个 Queue，HarnessInput 的 source 与 Queue
选择正交；主 Lane Queue 拥有独立执行位，side Lane Queues 共享支线并发容量。某条 Lane 忙碌时，
只阻塞自己的 Queue，不阻塞其它 Lane 中已就绪的 HarnessInput。

Core 向人发布 transcript、queue、Interaction、status、toast、Board 或 picker 时，统一走
Channel outbound，并以 `HumanPresentation` 通知 `human.outbound.before/after`。before 位于 surface state commit
之前；after 只说明 surface 已接收最新 presentation，不证明终端已经绘制或用户已经看见。多个更新可在
等待 before 时合并。若 before Hook 通过 Verb 打开 Interaction 并等待人的回答，该 Interaction
必须立即发布而不能递归进入同一个 before Hook，否则 Hook 会等待一个尚未展示的问题而自锁；这种
重入发布仍发送 after 通知。只有由当前 before Hook 因果链触发的发布可跳过同一 before；
其他并发 presentation 必须各自完整通知 Hook。
每个 Lane 同时最多一个 active Queue run，不同 Lane 可并行。Harness 也可以自行打开 Turn；
这类 Turn 没有对应 Queue item，但与其它 Turn 使用完全相同的 Event 和终态契约。

HarnessInput 另有一条与状态和 Lane 正交的 source 轴：composer、ProposedPlan 实施和用户编辑提交的
HarnessInvocation draft 是 `user`；`harness()` gate 批准后运行的 HarnessInvocation 是
`{ type: "plugin", pluginInstanceId }`。Input 顶层 `harnessInvocationId` 单独保存因果，
不混入 source。HarnessInvocation 是 Core 的持久执行记录，不是 Plugin 侧的 Harness 句柄；cron、Watch 和
Source 只负责唤醒 reconcile，不是 HarnessInput source。带 `harnessInvocationId` 的 queued HarnessInput 由
HarnessInvocation lifecycle 定向取消，不进入普通用户 recall。

### 2.2 Turn 开界

Turn 与 Lane 一样是 scope，不是执行器。Lane 提供长期归属，Turn 提供一次 Harness loop 的
临时归属；Event、Attempt、Interaction 等对象用 `turnId` 关联到这一边界。Queue 负责调度，
Controller 负责协调，Harness 负责执行，Turn 本身只表达 start/end。

Input 在 admission 前已经绑定实际 `laneId`。普通用户输入使用保留 ID `main`；
HarnessInvocation 在最终 Input 准备调度时，按 `laneId + newLane` 继续既有 Lane 或签发新 Lane。
每次 live verb 只创建一个 HarnessInvocation，并复用它已签发的实际 Lane ID。Controller 出队时先 append：

1. `user_message(source:<HarnessInput source>)`：保存原始 prompt，并保留 user/plugin 发起方；
2. `state_update(running, source:baton)`：为 Turn 开界。

Event kind 仍表示 Harness 看到的 user-role message，Event source 表示实际发起者，两者正交。
这两个事实不等待 Harness 冷启动。否则 prompt 会被进程启动时间绑住，Context prepend 也可能
被误写进正典历史。

### 2.3 Context 组装与交付

当前 `ContextSource` 首先承载 BatonSession 的缺失历史。Controller 按目标
`Lane × HarnessTarget` binding 的 HarnessSession 已确认水位组装 `(afterSeq, throughSeq]`，先持久化
`ContextSnapshot`，再选择 transport：

1. `sync_context`：Harness 提供独立同步能力；
2. `submit_side_channel`：随本次 `sendTurn` 的 side channel 送达；
3. `prompt_prepend`：都不支持时，在预算内 prepend 到 transport prompt。

Snapshot 只说明准备送什么。transport 接受后才 append `ContextDeliveryReceipt` 并推进该
HarnessSession 的 `ContextEpoch`；只有 Snapshot 没有 Receipt 时，下次必须重投。Context 注入
不修改 Codex、Claude Code 等原生 Session 文件，也不进入用户原始消息。增量追平只排除同一
`Lane × HarnessTarget` binding 已经亲历的 Turn；同 Lane 的其它 Target 是上一棒，同 Target 的其它
Lane 是并行进展，两者都必须以已完成 TurnSummary 注入。

### 2.4 Attempt 与 Adapter admission

Harness 已打开、Context 已组装后，Controller 先 append
`_baton_delivery_attempt_update(prepared)`，记录 Input、Target 和不可变
`HarnessLaunchSnapshot`。若存在 `harness.inbound.before` Hook，Core 此时以
`HarnessDelivery` 通知 Plugin；全部 settled 后才把 Attempt 推到 `dispatching` 并调用：

```ts
adapter.sendTurn(handle, promptInput)
```

Adapter 根据自己的权威运行态返回：

- `new_turn`：接受开启一轮新工作；
- `steer`：已接受向匹配的当前 Turn 投递；Harness 若内部还有原生队列，
  接受与进入模型上下文是两个独立事实；
- `rejected`：没有接受责任，Controller 可以安全降级为 queued follow-up。

Receipt 只确认 Adapter 接受了投递责任，不代表 Harness 已完成。accepted 后的错误必须通过事件流
终结 Turn；throw 只能表示 Adapter 尚未接受。Controller 据此持久化 Attempt 的 `accepted`、
`uncertain` 或最终 outcome，并以同一个 `attemptId` 发送非阻塞的 `harness.inbound.after`，其中
outcome 区分 `accepted/rejected/error`。same-turn steer 走同一 Hook 边界，但其 `attemptId` 只关联
本次 Adapter send，不会冒充新的持久 Delivery Attempt。

## 3. Harness 输出到用户

### 3.1 Adapter 归一

Adapter 消费原生 wire，把 message、thought、tool、diff、plan、task、usage、Interaction 和状态
翻译为 Baton Event 草稿。宿主在可信入口补齐 `source:harness`、Lane、HarnessTarget、
HarnessSession 和 Turn 坐标，BatonSession 再补 `eventId`、scope、时间与序号。

Event Ledger 只记录 Harness output 的 WAL。BatonSession 补齐信任坐标后先 record，随即直接
reduce Projection；Core 再把带 `eventId/seq` 的 `HarnessEventRecord` 通知
`harness.outbound.before/after`。Hook 不位于事实写入前，也不串行阻塞 Harness EventSink；
它只能观察已接受的事实，并通过 typed Verb 请求后续动作。Hook 异常或超时
fail-open，不能让 Plugin 截断 Harness 输出。

归一原则是“稳定语义 + raw 保真”：

- message/tool/plan 按稳定 ID upsert；
- 字段省略表示不变，`null`/空集合表示清除，具体值表示替换，chunk 表示追加；
- completed item 应携带全量内容，纠正此前丢失或乱序的 chunk；
- 原生粒度差异保留在 `raw`，Projection 与 Store 不出现 Harness 分支；
- 未知终态悲观处理，未知通知进入有界诊断和原生 trace，不静默吞掉。

### 3.2 record、reduce 与 Projection

所有 Event 都由 BatonSession 接受。实时数据流是 `reduce → Projection`；Ledger 是从
Event 分出的记录支路，不是 Projection 需要经过的一站：

```text
Event ── reduce ──→ Projection snapshot ──→ Channel outbound ──→ surface
  ├── record ──→ Event Ledger
  └── notify ──→ Hook ──→ Plugin
```

`record` 在当前实现中作为 WAL commit 点先于 reduce，但不承担事件总线职责。live 和重开
Session 使用相同 reducer。自愈也必须合成新的事实 Event 再走这条路径，不能直接
修改页面状态。chat-tui 只消费 transcript、activity、Interaction、status 等 view，不解析
Harness DTO。

多 Lane 仍 append 到同一 `session.jsonl`。全局 `seq` 只是 ledger 观察到的写入顺序，
不用来推断跨 Lane 因果。新 Lane 的原始 transcript 保留在 Lane 事实中；默认主时间线
把它投影为一张包含状态、Lane 和结果的任务卡片。

### 3.3 Turn 收口

正常完成、Harness error、子进程退出、transport close 和 cancel 最终都必须产生
`state_update(idle, stopReason)`；错误路径先产生 `_baton_error_update`。Controller 按 turn ID
幂等 finalize：

1. 持久化终态；
2. 生成一次 Turn summary；
3. finalize Delivery Attempt；
4. 取消仍挂在该 Turn 上的 Interaction；
5. 若存在关联的 Queue run，释放它并推进所属 Lane 的 Queue。

completed 但没有可见产出的空回合必须显式告警，不能表现成成功但无回复。

### 3.4 Harness 自行开始的 Turn

Harness 在没有新 Human Input 时也可能自行产生结果。Adapter 以 Harness 来源的 `running` 开界，
以 `idle` 收界；Controller 同样持久化、汇总和投影。由于没有对应的 Queue run，收界时也没有
Queue item 需要释放。Turn 本身不携带发起方向或角色分类。

## 4. Busy 输入、steer 与 interrupt

`follow-up` 是 Controller 的排队策略，不是 Adapter 的另一套方法。用户在 Harness busy 时提交
第二条输入：

1. Controller 先创建稳定 Input/message identity 并入队；若它位于队头、目标支持且当前 turn
   identity 匹配，再 claim 为 `dispatching` 并尝试 `sendTurn`；
2. Adapter 原生接受后，输入成为 `accepted_steer`，并以 `delivery:"steer"`
   绑定当前 Turn。若接受只代表进入 Harness 原生队列，其 delivery state 为
   `pending`；
3. Harness 确认该用户输入已写入模型上下文后，Adapter 将 delivery state 更新为
   `applied`；若 Harness 明确取消或丢弃该输入，则更新为 `failed` 并产生可见诊断。
   不能区分这些边界的 Harness，以原生接受作为 applied 边界；
4. Adapter 拒绝、原生 race 或无法安全定向时，同一 Input 回到队头，当前 Turn 结束后作为新 Turn
   执行。

`pending` steer 已是持久化的用户事实，但在时态上仍属于将来：TUI 将其放在
Composer Queue，收到 `applied` 回执后再投影到 Transcript；`failed` 则离开 Queue
但不冒充成 Transcript 历史。原生队列可能跨过当时尝试注入的 Turn，因此 Turn 收口不能
把 pending 自动当成 applied；它会留在 Queue，直到 Harness 报告应用或失败。queued follow-up
与 pending steer 共用 Queue surface，但前者等待 Controller 开启新 Turn，后者等待 Harness
原生投递边界，两者不能互相冒充。

`pending` / `failed` 同样不进入 TurnSummary 和后续 catch-up Context。延迟消息在
`started` 时开启新的 Turn，由该 Turn 承接实际 `applied` 的用户正文，避免尚未执行或
已经丢弃的指令提前污染下一棒上下文。

Esc 只打断主 Lane 当前 active Queue run 所关联的 Turn，不影响支线 Lane。已经 `applied` 的 steer
与该 Turn 共命运；仍是 `pending` 的 steer 以 Harness 原生 lifecycle 为准，interrupt 若保留
它就继续留在 Queue，不静默重发也不伪造取消。仍在 queue 的 follow-up 保留并在当前
Turn 收口后继续。cancel 请求本身不等于完成，
最终以 Harness 的 `idle/cancelled` 为准；超过 cancel 宽限且 transport 状态足够明确时，Controller
可以合成终态兜底。
HarnessInvocation 只用 invocation identity 定向取消自己的 queued HarnessInput 或 active Queue run，不论它位于主 Lane
还是新 Lane。

## 5. Interaction 闭环

Interaction 表示“某个 requester 正在等待 typed decision”，当前 kind 包含 permission、question、
suggested input、HarnessInvocation gate 和 hook trust。它是 Core-owned rendezvous，不是 Harness
与 Plugin 互传任意 payload 的消息信封。decision 可以由人提交，也可以由宿主 policy 自动给出；
自动决议同样必须留下 requested/answered 事实。
HarnessInvocation gate 同时固化 prompt、HarnessTarget 和 Lane policy，确保 policy 或用户批准的是
随后实际执行的同一份请求。
完整闭环是：

```text
Harness native verb → Adapter lowering ┐
Plugin reconcile verb → Host lowering ─┴→ kind-specific draft
  → Core signs interactionId + requester
  → interaction.requested persisted
  → Channel outbound presents to a Human surface, or host policy resolves it
  → user/policy answers, or request is cancelled
  → interaction.answered / interaction.cancelled persisted
  → waiting Adapter or Plugin execution continuation resumes
```

Harness Adapter 负责把原生 request approval / request user input 等 verb 归一成 `InteractionDraft`，
但不自签 interaction ID，也不自行伪造 requested/answered/cancelled。Plugin host 则把全部 reconcile
verb 归一到封闭的 Interaction kind。`draft` 的 submitted 和 `harness` 的 approved 结果才允许 Core
创建 HarnessInvocation；gate 阶段的 dismissed/declined 不产生执行记录。result 本身不进入 prompt queue。

两类 requester 共享 identity、持久化、展示与终态规则，并都恢复当前等待 continuation：Harness
result 返回 Adapter continuation，Plugin result 返回当前 Runner 或 in-process reconcile continuation。
Plugin verb 的 deadline 由必填 `timeoutMs` 计算并随 Interaction 持久化；timeout、用户 Esc、执行失败
和恢复清理都先记录终态，所有终态遵守 first-terminal-wins。

`await ctx.verbs.ask(...)` 会真实等待人的结果。等待期间 Baton 保留当前 async continuation，但释放该
Controller 的并发位和 Manager 总并发位，使其它 Resource 继续 reconcile；结果落盘后重新取得并发
位并返回 `success / dismissed / timeout / failure`。Plugin execution 由 Core identity 关联，Resource
不是 verb continuation key。Runner 或 Core 崩溃时进程内调用栈不重放，未完成 verb 作为
`failure` 收口。

自动 reviewer 没有向 Baton 打开 Interaction 时，审批回执是独立 `ApprovalReview` 审计事实，
不能伪造一组 requested/answered；详见 [审批生命周期](./approval-lifecycle.md)。

## 6. 失败、对账与恢复

### 6.1 无法证明投递结果

如果进程断开时 Baton 无法证明 Harness 是否接受或完成，Attempt 保留 `uncertain`。恢复先观察
Harness 和 Event Ledger，再决定 finalize；不能为了让队列前进而无条件重投可能已有副作用的工作。

### 6.2 静默悬挂

固定 wall-clock 超时会误杀合法长任务，因此 Baton 只把“长时间无事件”当作 stall signal：

- L1：记录 stall notice，使静默可见，但不自动 finalize；
- L2：Adapter 声明 `reconcile` 时查询 Harness 权威运行态；只有明确 idle 才合成终态；
- 无对账能力或结果 unknown 时交给用户继续等待或取消。

### 6.3 Session 恢复与 Harness 接力

BatonSession 从 Event Ledger 重放 Projection、Attempt、Interaction 和 Context 水位。Lane registry
从 Session meta 恢复；若其原生 HarnessSession identity 仍可恢复，Adapter 使用它加速继续；
否则在同一 Lane 里新建原生 Session，并通过
Context delivery 补齐 BatonSession 历史。切换 Harness 也是同一机制，不需要复制粘贴上下文。
原生 steer 队列属于 Adapter 进程而非 HarnessSession 历史；recovery 看到遗留的 `pending`
时将其收口为 `failed` 并告警，不猜测已应用，也不自动重投。

外部 HarnessSession 必须先由只读 Inspector 生成完整历史 Snapshot，再 adoption 为
BatonSession；此后 resume/fork 只走 BatonSession 主路径。详细边界见 [Harness](./harness.md)
和 [resume 与 fork](./resume-fork.md)。

## 7. 代码与测试锚点

- `src/channel/`、`src/tui/protocol/presentation.ts` — Human/Core 双向边界与 chat-tui outbound 适配
- `src/controller/input.ts`、`turn.ts`、`attempt.ts` — Input、Turn 与 Delivery Attempt owner
- `src/context/delivery.ts` — Snapshot、Receipt 与 Epoch
- `src/interaction/types.ts`、`harness.ts`、`reconcile.ts` — Interaction 公共模型与两种 continuation
- `src/event/`、`src/store/reduce.ts` — Event 信封、append/reduce 与投影状态
- `tests/input-lifecycle.test.ts`、`tests/delivery-attempt.test.ts` — 输入与投递状态迁移
- `tests/lifecycle.test.ts`、`tests/reconcile.test.ts` — 终态与 stall 对账
- `tests/cancel-cascade.test.ts`、`tests/harness-initiated-turn.test.ts` — Interaction 级联和 Harness-started Turn
