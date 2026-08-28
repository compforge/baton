# Baton Kernel

本文定义 Baton 的最小稳定内核：Core 协调谁、核心对象如何关联，以及所有 Harness 和 Plugin
都不能绕过的约束。Input lowering、Queue 状态机与 Harness 投递顺序见[工作流](./workflow.md)；
Harness 适配见 [Harness](./harness.md)，长期领域 loop 见 [Plugin](./plugin.md)，Human surface 适配见
[View](./view.md)。

## 1. 定位与边界

Baton 是 terminal-native 的 Loop Engineering 协作内核与控制面，也是跨 coding agent 的统一工作区。
用户拥有的不是某个 agent 进程，而是可持久、可恢复、可跨 Harness 接力的 `BatonSession`。
Codex、Claude Code 等原生会话提供推理、工具调用和恢复加速，但不是 Baton 的逻辑历史。

Baton Core 位于三类参与者之间：

| 参与者 | 负责 | 通过 Core 协作 |
|---|---|---|
| **Human** | 目标、输入、编辑和最终决议 | 通过 View 提交 ViewInput、回答 Interaction、消费 ViewOutput |
| **Harness** | 推理、工具调用和原生执行会话 | 接收 HarnessInput，产生 HarnessEvent、Interaction request 和 receipt |
| **Plugin** | 领域 loop、Connector 和完成条件 | 通过 Hook 或 reconcile 被唤醒，通过 Resource API / Verb 请求 Core 行动 |

Core 是三方的协调者，不代替任何一方完成其工作。用户级 `Baton Daemon` 是长期存活的控制面进程；
它拥有 Plugin Host、Human Inbox 与 Session Gateway。Plugin Host 按启用的 PluginInstance 管理
Binding 与 Worker，并按每份 Resource 自身的 namespace 驱动 Controller/reconcile。`Channel` 只是一份
BatonSession lease 期间的交互与 Harness 执行入口：它装配 Session、Queue、Interaction gateway 与
Harness ports，也是 typed ViewInput 的统一 facade 和 ViewOutput 的发布边界。各 owner 仍分别拥有
事实、状态机、调度与执行职责。参与者不能互持进程句柄、私建回调通道，也不能绕过 Core 直接改变
另一方状态。

Channel 只借用网络框架中 active endpoint、request inbound、response outbound 和 close settlement 的
方向感；它是 Baton 的固定 typed path，不复制可任意挂载 handler 的通用 pipeline。Plugin 扩展点仍是
Hook 通知与 Resource API / Verb 请求；写操作每次都重新进入完整的 Core-owned path，不从当前 Hook
位置继续传播。

View 位于内核之外。`chat-tui` 是 Baton 与 Doctor 可共同使用的公共终端交互库；Baton 的
`src/view/chat-tui` Adapter 把其 intent 变成 ViewInput，并把 Core Projection 变成 ChatState；成功
publication 再形成轻量 ViewOutput 边界。
View 不拥有 Controller、Plugin Host、Session lease 或领域事实，也不解释 Requirement、Deployment、
Review 等领域语义。完整边界见 [View](./view.md)。

## 2. 最小核心模型

| 概念 | 语义与 owner |
|---|---|
| **Baton Daemon** | 用户级常驻控制面进程；拥有 Plugin Host、Human Inbox、Session Gateway 及 Resource 控制面服务 |
| **Plugin Host** | Daemon 内的 Plugin 管理组件；按 Instance 管理 Binding 与 Worker，按 Resource namespace 持有 Resource/Controller 并驱动 reconcile |
| **BatonSession** | Human 拥有的持久协作空间和交互/执行入口；承载 Event Ledger 与 Lane，不因 Plugin 的全局或项目 scope 复制领域事实 |
| **Channel** | BatonSession 的 active composition root 与 typed coordination facade；拥有进程期组件引用、订阅和 `open/closing/closed`，不拥有任何可恢复业务状态或状态机 |
| **PluginBinding** | 一份启用 PluginInstance 的具体激活；拥有注册与清理生命周期，不决定 Resource namespace |
| **Human Inbox** | Baton 与 Human 之间的持久待决/复核列表；所有 Plugin 发起的 human-facing action 都先进入这里 |
| **ViewInput** | View 提交给 Baton 的原始输入事实；可以是 text/prompt、command、configuration、Interaction response 或 interrupt，并非所有 Input 都会进入 Harness |
| **ViewOutput** | Core 发布给 View 的投影更新；表示可供 surface 消费，不证明用户已经看见 |
| **HarnessInput** | Core lowering 后准备交给 Harness 的输入；具有稳定 message identity、目标 Lane 和可查询消费状态 |
| **HarnessEvent** | Adapter 将 Harness 原生流式观察归一后的输出；Core 补齐可信坐标并提交后才成为 Baton Event |
| **Queue** | 一条 Lane 的 HarnessInput 背压缓冲；Lane 内按入队顺序串行，决定等待、steer、取消和何时提交给 Harness |
| **Lane** | BatonSession 内持久的任务线边界；Lane 内串行，不同 Lane 可以并行，可在多个 Harness 之间接力 |
| **Turn** | Human 与 Harness 的一次交流边界；通常是一问一答，也可以只有 Harness 的回答。Turn 有稳定 `turnId` 和 start/end，但不排队、不调度，也不执行工作 |
| **Event Ledger** | BatonSession 的 append-only WAL 和历史记录；它保存正典 Event 供审计与回放，不负责调度、reduce 或实时分发 |
| **Interaction** | Harness 或 Plugin 等待 Human 或 policy 给出 typed decision 的持久协作对象；Core 拥有 requested/answered/cancelled 生命周期 |
| **Resource / reconcile** | Plugin 表达长期期望状态并主动推进领域 loop 的机制；领域事实与完成条件归 Plugin 和外部系统所有 |
| **Hook / Resource API / Verb** | Hook 通知 Core 边界事实；Resource API 修改开放的期望字段；Verb 请求 typed action。Hook 不返回控制决策，写操作不绕过 Core |

HarnessTarget、HarnessSession、Binding、Handle 和 Capability 属于 Harness 执行边界；HarnessInvocation、
Delivery Attempt 与具体 Input 状态机属于工作流；Board、Context 与 Plugin execution 属于 Plugin 控制面。
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
`turnId`。Turn 不等于一次 LLM call、一次 tool call 或一个 Queue worker。Harness 在没有新
ViewInput 时也可以产生答案，此时仍建立普通 Turn，只是没有对应的提问。

`TurnRegistry` 只是可丢弃、可由 Event 重建的运行期索引，不保存 Input、Queue、取消、投递或释放
状态，也不是第二份 Ledger。

### 2.2 Channel 只拥有活跃生命周期

同一 BatonSession lease 同时只有一个 active Channel。创建 Channel 时固定装配 Session Controller、
Interaction requester 路由、Session Gateway 和 Harness Adapter ports；恢复时先由 BatonSession/Event
Ledger 与 Plugin Resource 恢复权威事实，再创建一个全新的 Channel。旧 Channel 的调用栈和临时引用
不参与恢复。Channel 关闭只注销 Session，不关闭 global/project Plugin Worker。

Channel 接受 typed ViewInput 后返回 dispatch receipt；Queue admission、Harness receipt 和 Turn 终态仍由各自
owner 继续报告，调用方不必把完整 Turn 阻塞在 intake 调用栈。`close()` 先停止新 intake，再按固定顺序关闭
活跃组件、撤销订阅、flush Session 并释放 lease；它是幂等的，重复调用共享同一个 close settlement。

## 3. 三条核心路径

### 3.1 Human 到 Harness

ViewInput 先进入 Channel，由 BatonSession 接受为 Event，再由 Channel 调用正确 owner 的高层语义方法。
当前 WAL 顺序是先 record Event，再 reduce Projection 并继续 lowering；Ledger 只记录这个事实，不驱动后续流程。
不同 Input 可以推进不同对象：

```text
Human
  ↓ ViewInput
Channel typed dispatch
  ↓
BatonSession accepts Event
  ├─ record ─────────────────────→ Event Ledger
  ├─ reduce ─────────────────────→ Projection
  ├── prompt/text ─────────────→ HarnessInput → target Lane Queue → Adapter → Harness
  ├── interrupt ───────────────→ 当前 Queue run / Harness cancel
  ├── Interaction response ────→ Interaction
  └── command/configuration ───→ 对应 Core 或 surface 操作
```

Queue 是 Human 到 Harness 主路径上的调度者，但 ViewInput 不等于 HarnessInput，Turn 也不等于 Queue item。
一个 Input 可以只改变 Core 状态；只有需要 Harness 执行的内容才 lowering 为 HarnessInput。

`view.input` 和 `harness.input` Hook 可以把这条路径上的事实通知 Plugin。Hook 不替换 Input、
不决定 allow/deny，也不直接改变 Queue；Plugin 如需行动，必须通过 Verb 请求 Core。

### 3.2 Harness 到 Human

Harness output 经 Adapter 归一为 HarnessEvent，Core 提交为 Event 后由 BatonSession 直接 reduce 出
Projection，再经 Channel 发布为 ViewOutput 交给 Human surface。
Event 同时被 Ledger 记录、被 Hook 通知给 Plugin；两者都不是 Projection 的中转站：

```text
Harness → Adapter normalize → HarnessEvent → Core commit → Event → reduce → Projection → Channel outbound → Human
                                   ├─ record ───→ Event Ledger
                                   └─ notify ───→ Hook → Plugin
```

Harness 不直接写 UI，也不自己宣布整个业务完成。正常完成、error、cancel、子进程退出和 transport
close 最终都必须产生或合成 Turn 终态；Core 按 `turnId` 幂等收界。

### 3.3 Plugin 与 Core

Plugin 有两种被驱动的方式，但所有面向人的动作先进入同一个出口：

```text
被动：Core boundary ── Hook ───────────────┐
                                          ├─→ Plugin ── Verb ──→ Human Inbox
主动：Source / Watch / Resource ─ reconcile┘                     │
                                                                 ├─ 人直接决策
                                                                 └─ claim Session → Harness execution
```

Hook 适合观察当前输入、输出或展示边界；Resource + reconcile 适合跨 Session、跨进程和跨时间持续逼近
长期目标。两条路径都不能直接调用 Harness 或修改 Human surface。Verb 只表达 typed request；Core 再把
请求物化为 Interaction、HarnessInvocation、HarnessInput、ViewOutput 或其它自己拥有的对象。

Plugin 决定领域下一步，Core 决定协作动作如何授权、持久化、分发、调度和恢复。用户在哪个 Session
领取并决定需要 Agent 执行的事项，就由该 Session 执行；执行结果仍回到同一 Human Inbox action 等待
复核。这使 Core 保持业务无关，
又不会退化成任意 payload 消息总线。

## 4. 运行边界

```text
User-level Baton Daemon
├── Plugin Host
│     └── enabled PluginInstance × one Binding / Worker
│           ├── Resource(namespace) / Controller / reconcile
│           └── Plugin Worker ── typed Plugin verb ──┐
├── Human Inbox ◀────────────────────────────────────┘
└── Session Gateway
        ▲
        │ attach / badge / claim / execute / review
        ▼
Session process × active terminal tab
├── View Adapter ↔ Channel ↔ Session / Queue / Interaction
└── Harness Adapter ↔ Harness
```

`Plugin Host` 不是第二个 daemon，也不是独立进程；它是 Baton Daemon 内按 PluginInstance 管理
Binding 和 Worker 的组件。每个 Binding 把 Package 注册、Controller/reconcile 调度和 Worker 生命周期
收在同一边界；
Human Inbox 与 Session Gateway 仍是 Host 的同级服务。第三方 Package 运行在独立 Plugin Worker 中；
Worker 是 Daemon 的子进程。Harness 进程或 SDK 生命周期仍由领取工作的 Session Adapter 持有。

Plugin 不声明 scope 或 namespace；它只是 Resource schema、Controller、Source 与 Connector 的组织单位。
每个启用的 PluginInstance 只有一份 Binding 和 Worker，不随 terminal tab、Project 或 Resource 数量复制。
Resource 自己携带 canonical namespace：

| Resource namespace | 归属与 Inbox 分发语义 |
|---|---|
| `v1` | 用户全局；所有 Session 可见，只有一个 Session 收到瞬时提示 |
| `v1/project/<projectId>` | Project 级；同 Project Session 共享 Resource 和待决事项 |
| `v1/project/<projectId>/session/<sessionId>` | Session 级；Inbox 持久化后直达目标 Session |

ResourceType 不声明 scope；同一个 Plugin、Controller 和 kind 可以同时管理不同 namespace 的对象。
namespace 是 Resource identity 与 action 路由的一部分，不是 Package、PluginInstance 或 Worker identity。

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

ViewInput 先 record `input.received`，再通知 Hook 或 lowering；HarnessInput 每次 Queue 迁移先
record `harness_input.updated`，再修改内存执行索引；Harness output 先 record 和 reduce，再通知
Hook；Delivery Attempt 先持久化 `prepared`，再调用 Adapter。这是 write-ahead 的提交顺序，
不表示 Ledger 驱动 Projection 或后续动作。live 与 replay 使用同一 reducer；自愈也必须
接受新的事实 Event，不能直接改页面状态。Plugin Resource 与外部系统仍拥有各自领域事实。
无法证明副作用是否发生时保留 `uncertain`，不盲目重投。

### 5.2 Scope 不执行工作

Lane 与 Turn 只定义 identity、边界和归属。Queue 负责调度，Controller 负责协调，Harness 负责执行，
Plugin 负责领域判断；不能把 Input、Queue 状态、取消定时器或执行逻辑重新挂回 Lane/Turn。

### 5.3 Hook 通知，Resource API / Verb 请求动作

Hook 不是第四类参与者，也不是准入或替换拦截器。它只把 `view.input`、`view.output`、
`harness.input`、`harness.output` 四个稳定 IO 边界通知 Plugin，没有 replacement 或 allow/deny 返回值。
Plugin 对 Core-owned Resource 的有限期望修改走通用 Resource API，其它行动通过 typed Verb 请求 Core；
两者都由 Core 执行 WAL、权限和生命周期规则。

### 5.4 终态封闭，未知悲观

每个已开始的 Turn 必须恰好逻辑收口一次。物理终态允许重复或迟到，Core 按 `turnId` 幂等处理；
开放的 Harness 状态在 Adapter 边界归一，未知终态不能乐观映射为成功。原始协议保留在 Event `raw`，
未知通知进入有界诊断而不是静默丢弃。

### 5.5 单 Ledger、多 Lane

一个 BatonSession 只有一份 Event Ledger，但每条 Lane 拥有自己的 Queue。`seq` 只表示 append 的全局
观测顺序，不表示跨 Lane 因果；因果由 `turnId`、`parentEventId` 和领域 identity 表达。每个 Lane
同时最多一个 active Queue run，Lane 内保持串行，不同 Lane 可以并行。

### 5.6 Core 不理解端点业务

Harness 差异只能存在于 Adapter、Definition、Inspector 和 Capability；Requirement、Deployment、
Review 等领域语义只能存在于 Plugin、Resource 和 Connector。Core 只理解稳定协作对象及其 identity、
owner、权限、生命周期和恢复规则，不出现 `if harness === ...`，也不内建某条业务 Flow。

### 5.7 Plugin 归控制面，Session 归交互与执行

global/project Binding 的 Worker 生命周期不能绑在某个 Channel 上；Session attach/detach 只改变可见性、
提示和执行入口。所有 human-facing action 先持久化到 Human Inbox，再按 namespace 计算 eligible
Sessions；领取是原子的，同一事项不能被两个 tab 同时执行。Session 在执行中断开时不得乐观重投，
Inbox 必须保留可复核的失败或不确定结果。

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
- [View](./view.md) — View Adapter、chat-tui 公共库与 surface 接入边界
- [审批生命周期](./approval-lifecycle.md) — permission、授权方与 auto-review 回执
- [Session Paths](./session-paths.md)、[resume 与 fork](./resume-fork.md) — 会话分支、恢复与收录
- [日志体系](./logging.md) — Baton、Harness 与 Plugin 的结构化诊断
- [Backlog](./backlog.md) — 有意识暂缓的能力和启动条件
