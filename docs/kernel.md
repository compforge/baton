# Baton Kernel

本文定义 Baton 的最小稳定内核：Core 协调谁、核心对象如何关联，以及所有 Harness 和 Plugin
都不能绕过的约束。Input lowering、Queue 状态机与 Harness 投递顺序见[工作流](./workflow.md)；
Harness 适配见 [Harness](./harness.md)，长期领域 loop 见 [Plugin](./plugin.md)。

## 1. 定位与边界

Baton 是 terminal-native 的 Loop Engineering 协作内核与控制面，也是跨 coding agent 的统一工作区。
用户拥有的不是某个 agent 进程，而是可持久、可恢复、可跨 Harness 接力的 `BatonSession`。
Codex、Claude Code 等原生会话提供推理、工具调用和恢复加速，但不是 Baton 的逻辑历史。

Baton Core 位于三类参与者之间：

| 参与者 | 负责 | 通过 Core 协作 |
|---|---|---|
| **Human** | 目标、输入、编辑和最终决议 | 提交 Input，回答 Interaction，消费 Projection |
| **Harness** | 推理、工具调用和原生执行会话 | 接收 HarnessInput，产生 Interaction request、Event 和 receipt |
| **Plugin** | 领域 loop、Connector 和完成条件 | 通过 Hook 或 reconcile 被唤醒，通过 Verb 请求 Core 行动 |

Core 是三方的协调者，不代替任何一方完成其工作。它接收 Human Input、Harness output 和 Plugin Verb，
负责持久化、路由、权限、调度、取消、恢复与 Projection。参与者不能互持进程句柄、私建回调通道，
也不能绕过 Core 直接改变另一方状态。

chat-tui 位于内核之外：它把键盘、文本和页面操作变成 Human Input，并展示 Core Projection；它不拥有
Session、Queue、Harness 或 Plugin 生命周期，也不解释 Requirement、Deployment、Review 等领域语义。

## 2. 最小核心模型

| 概念 | 语义与 owner |
|---|---|
| **BatonSession** | Human 拥有的持久协作空间；承载 Event Ledger、Lane 与 session-scoped Plugin 数据 |
| **Input** | Human 提交给 Baton 的原始输入事实；可以是 text/prompt、command、configuration、Interaction response 或 interrupt，并非所有 Input 都会进入 Harness |
| **HarnessInput** | Core lowering 后准备交给 Harness 的输入；具有稳定 message identity、目标 Lane 和可查询消费状态 |
| **Queue** | Core 的全局调度对象；当前主要承载 HarnessInput，决定等待、steer、取消和何时提交给 Harness |
| **Lane** | BatonSession 内持久的任务线边界；Lane 内串行，不同 Lane 可以并行，可在多个 Harness 之间接力 |
| **Turn** | Human 与 Harness 的一次交流边界；通常是一问一答，也可以只有 Harness 的回答。Turn 有稳定 `turnId` 和 start/end，但不排队、不调度，也不执行工作 |
| **Event Ledger** | BatonSession 的 append-only WAL 和历史记录；它保存正典 Event 供审计与回放，不负责调度、reduce 或实时分发 |
| **Interaction** | Harness 或 Plugin 等待 Human 或 policy 给出 typed decision 的持久协作对象；Core 拥有 requested/answered/cancelled 生命周期 |
| **Resource / reconcile** | Plugin 表达长期期望状态并主动推进领域 loop 的机制；领域事实与完成条件归 Plugin 和外部系统所有 |
| **Hook / Verb** | Hook 把 Core 边界事实通知 Plugin；Verb 让 Plugin 请求 Core 执行 typed action。Hook 不返回控制决策，Verb 不绕过 Core |

HarnessTarget、HarnessSession、Binding、Handle 和 Capability 属于 Harness 执行边界；HarnessInvocation、
Delivery Attempt 与具体 Input 状态机属于工作流；Board、Context 与 Plugin execution 属于 Plugin 运行时。
它们都有明确类型和契约，但不与上述最小模型平级。

### 2.1 Lane 与 Turn 只表达归属

Lane 和 Turn 都提供 identity 与归属感，但不是执行器：

```text
BatonSession
└── Lane                         持久任务线
    └── Turn                     一次 Human ↔ Harness 交流
        ├── Event
        ├── Interaction
        └── Delivery Attempt
```

Lane 决定工作属于哪条长期任务线；Turn 让本次交流中的 Event、Interaction、Attempt 等对象共享
`turnId`。Turn 不等于一次 LLM call、一次 tool call 或一个 Queue worker。Harness 在没有新 Human
Input 时也可以产生答案，此时仍建立普通 Turn，只是没有对应的提问。

`TurnRegistry` 只是可丢弃、可由 Event 重建的运行期索引，不保存 Input、Queue、取消、投递或释放
状态，也不是第二份 Ledger。

## 3. 三条核心路径

### 3.1 Human 到 Harness

Human Input 先由 BatonSession 接受为 Event，再由 Core lowering。当前 WAL 顺序是先
record Event，再 reduce Projection 并继续 lowering；Ledger 只记录这个事实，不驱动后续流程。
不同 Input 可以推进不同对象：

```text
Human
  ↓ Input
BatonSession accepts Event
  ├─ record ─────────────────────→ Event Ledger
  ├─ reduce ─────────────────────→ Projection
  ├── prompt/text ─────────────→ HarnessInput → Queue → Adapter → Harness
  ├── interrupt ───────────────→ 当前 Queue run / Harness cancel
  ├── Interaction response ────→ Interaction
  └── command/configuration ───→ 对应 Core 或 surface 操作
```

Queue 是 Human 到 Harness 主路径上的调度者，但 Input 不等于 HarnessInput，Turn 也不等于 Queue item。
一个 Input 可以只改变 Core 状态；只有需要 Harness 执行的内容才 lowering 为 HarnessInput。

`human.inbound` 和 `harness.inbound` Hook 可以把这条路径上的事实通知 Plugin。Hook 不替换 Input、
不决定 allow/deny，也不直接改变 Queue；Plugin 如需行动，必须通过 Verb 请求 Core。

### 3.2 Harness 到 Human

Harness output 经 Adapter 归一为 Event，BatonSession 直接 reduce 出 Projection 供 Human 消费。
Event 同时被 Ledger 记录、被 Hook 通知给 Plugin；两者都不是 Projection 的中转站：

```text
Harness → Adapter normalize → Event → reduce → Projection → Human
                                   ├─ record ───→ Event Ledger
                                   └─ notify ───→ Hook → Plugin
```

Harness 不直接写 UI，也不自己宣布整个业务完成。正常完成、error、cancel、子进程退出和 transport
close 最终都必须产生或合成 Turn 终态；Core 按 `turnId` 幂等收界。

### 3.3 Plugin 与 Core

Plugin 有两种被驱动的方式，但只有一种动作出口：

```text
被动：Core boundary ── Hook ───────────────┐
                                          ├─→ Plugin ── Verb ──→ Core
主动：Source / Watch / Resource ─ reconcile┘
```

Hook 适合观察当前输入、输出或展示边界；Resource + reconcile 适合跨 Session、跨进程和跨时间持续逼近
长期目标。两条路径都不能直接调用 Harness 或修改 Human surface。Verb 只表达 typed request；Core 再把
请求物化为 Interaction、HarnessInvocation、HarnessInput、presentation 或其它自己拥有的对象。

Plugin 决定领域下一步，Core 决定协作动作如何授权、持久化、调度和恢复。这使 Core 保持业务无关，
又不会退化成任意 payload 消息总线。

## 4. 运行边界

```text
                            Baton host process
┌──────────┐ Human Input   ┌──────────────────────────────────────┐
│  Human   │◀─────────────▶│ Input / Queue / Interaction          │
│ via TUI  │  Projection   │ Session / Event Ledger / Policy      │
└──────────┘               │ Routing / Scheduling / Recovery      │
                           └──────────────┬───────────────┬────────┘
                                          │               │
                                   stable contract        │ IPC
                                          ▼               ▼
                                  Harness Adapter     Plugin Runner
                                          │               │
                                          ▼               ▼
                                       Harness       Connector / domain
```

进程边界按故障与 owner 划分，不按页面区域划分。Host 拥有 Controller、BatonSession、Queue 和展示快照；
Harness 进程或 SDK 生命周期由 Adapter 持有；第三方 Plugin 按活动 Binding 运行在独立 Runner 进程。

内核只有一条双向流水线。这里给出概念拓扑，完整状态迁移和时序以[工作流](./workflow.md)为准。

![Baton 内核双向流水线](./kernel-pipeline_v1.svg)

## 5. 关键不变量

### 5.1 Event 是事实，Ledger 是 WAL

BatonSession 内一切可恢复、可展示或会触发动作的协作事实都表达为 Event。
Session 是实时入口，它用同一个 Event 同步维护 Ledger 和 Projection：

```text
accept Event
  ├─ record ──→ Event Ledger
  ├─ reduce ──→ Projection
  └─ notify ──→ Session observers

prepared Event → external action → outcome Event
```

Human Input 先 record `input.received`，再通知 Hook 或 lowering；HarnessInput 每次 Queue 迁移先
record `harness_input.updated`，再修改内存执行索引；Harness output 先 record 和 reduce，再通知
Hook；Delivery Attempt 先持久化 `prepared`，再调用 Adapter。这是 write-ahead 的提交顺序，
不表示 Ledger 驱动 Projection 或后续动作。live 与 replay 使用同一 reducer；自愈也必须
接受新的事实 Event，不能直接改页面状态。Plugin Resource 与外部系统仍拥有各自领域事实。
无法证明副作用是否发生时保留 `uncertain`，不盲目重投。

### 5.2 Scope 不执行工作

Lane 与 Turn 只定义 identity、边界和归属。Queue 负责调度，Controller 负责协调，Harness 负责执行，
Plugin 负责领域判断；不能把 Input、Queue 状态、取消定时器或执行逻辑重新挂回 Lane/Turn。

### 5.3 Hook 通知，Verb 请求动作

Hook 不是第四类参与者，也不是准入或替换拦截器。它只把 Human→Harness 的 inbound 边界和 Harness→Human
的 outbound 边界通知 Plugin，没有 replacement 或 allow/deny 返回值。Plugin 的所有副作用都通过
typed Verb 回到 Core；Core 再执行 WAL、权限和生命周期规则。

### 5.4 终态封闭，未知悲观

每个已开始的 Turn 必须恰好逻辑收口一次。物理终态允许重复或迟到，Core 按 `turnId` 幂等处理；
开放的 Harness 状态在 Adapter 边界归一，未知终态不能乐观映射为成功。原始协议保留在 Event `raw`，
未知通知进入有界诊断而不是静默丢弃。

### 5.5 单 Ledger、多 Lane

一个 BatonSession 只有一份 Event Ledger。`seq` 只表示 append 的全局观测顺序，不表示跨 Lane 因果；
因果由 `turnId`、`parentEventId` 和领域 identity 表达。每个 Lane 同时最多一个 active Queue run，
Lane 内保持串行，不同 Lane 可以并行。

### 5.6 Core 不理解端点业务

Harness 差异只能存在于 Adapter、Definition、Inspector 和 Capability；Requirement、Deployment、
Review 等领域语义只能存在于 Plugin、Resource 和 Connector。Core 只理解稳定协作对象及其 identity、
owner、权限、生命周期和恢复规则，不出现 `if harness === ...`，也不内建某条业务 Flow。

## 6. 演进规则

判断新能力落点时依次问：

1. 事实由谁拥有，生命周期由谁收口？
2. 它属于 Input lowering、Queue 调度、Turn/Lane scope、Harness 适配，还是 Plugin 领域 loop？
3. 它需要持久身份、恢复和对账，还是仅是短寿命 signal/view？
4. Plugin 是通过 Hook 被动观察，还是通过 Resource + reconcile 主动推进？最终动作是否仍由 Verb 请求 Core？
5. 提升内核后，能否保持新增 Harness 不修改 Session、Event Ledger、Projection 和 chat-tui？

signal 只提示重新读取权威状态，不能冒充 Event。Board 更新、Context 已交付和 Harness 已被唤醒是
彼此独立的事实；批量 fan-out、结果策展等尚未稳定的能力留在 [Backlog](./backlog.md)，不提前进入
Kernel。

## 7. References

- [工作流](./workflow.md) — Input lowering、HarnessInput、Queue、Turn 与 Interaction 闭环
- [Harness](./harness.md) — Target、Session、Adapter、Capability 与扩展契约
- [Plugin](./plugin.md) — Resource/reconcile、Hook/Verb、Runner、Board 与 Context
- [审批生命周期](./approval-lifecycle.md) — permission、授权方与 auto-review 回执
- [Session Paths](./session-paths.md)、[resume 与 fork](./resume-fork.md) — 会话分支、恢复与收录
- [日志体系](./logging.md) — Baton、Harness 与 Plugin 的结构化诊断
- [Backlog](./backlog.md) — 有意识暂缓的能力和启动条件
