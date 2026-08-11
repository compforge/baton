# Baton Kernel

本文定义 Baton 的稳定内核：它解决什么问题、核心对象由谁拥有、依赖如何流动，以及所有
Harness 和 Plugin 都不能绕过的约束。一次 Input 如何到达 Harness、Harness 结果如何返回
用户，统一见 [工作流](./workflow.md)；适配协议见 [Harness](./harness.md)，长期领域 loop 见
[Plugin](./plugin.md)。

## 1. 理念与边界

Baton 是 terminal-native 的 Loop Engineering 控制面，也是跨 coding agent 的统一工作区。
用户拥有的不是某个 agent 进程，而是可持久、可恢复、可跨 Harness 接力的 `BatonSession`。
Codex、Claude Code 等原生会话用于执行与加速恢复，不能成为逻辑历史的唯一载体。

Baton 按三层协作：

1. **Baton core** 负责 Input、Interaction、Event、Context、权限、Harness routing、调度和
   Projection，不理解 Requirement、Deployment、Review 等领域语义。
2. **Baton Plugin** 以 Resource 的 `spec/status` 表达长期领域 loop，由 Controller reconcile；
   通过 `ReconcileContext` 请求人的决定、准备草稿或发起 Harness Turn，不能直接调用 Harness。
3. **Harness** 提供智能执行能力，Adapter 把各家协议归一成稳定契约。devloop 等 Harness
   Plugin 只约束 Harness 内部的小闭环，不成为 Baton Plugin 的私有执行接口。

chat-tui 位于内核之外：它消费展示快照并产生 intent，不拥有 Session、队列、Harness 或 Plugin
生命周期，也不解释领域语义。

## 2. 核心模型

### 2.1 三域视角

从控制关系看，内核收束为三个协作域：

| 域 | 负责 | 不负责 |
|---|---|---|
| **Input** | 表达进入 Baton 的刺激；当前主要是用户 prompt、interaction result 和 control | 不理解 Harness wire，不决定执行终态 |
| **Controller** | admission、queue、Attempt、Turn、Interaction、Event 持久化和 Projection | 不实现 Harness 方言，不依赖具体 UI shape |
| **Harness** | Target、原生 Session、Adapter、Capability 和原生事件归一 | 不拥有用户输入生命周期，不直接向页面投影 |

控制方向是 `Input → Controller → Harness`；感知方向是
`Harness → Controller → Projection → 用户`。Input 与 Harness 不直接依赖，只有 Controller
同时理解两侧稳定契约。

### 2.2 身份、owner 与生命周期

| 概念 | 语义与 owner |
|---|---|
| **Project** | 按 cwd 组织和发现 BatonSession，并承载同 workspace 跨 Session 的 Plugin 私有数据；不拥有 Session 历史 |
| **BatonSession** | 用户拥有的正典逻辑历史和 session-scoped Plugin 数据；跨 Harness 的唯一时间线 |
| **HarnessTarget** | Baton 配置、调度和状态查询侧的一份具体执行目标；同一 Harness 可有多个 Target，状态必须按 Target 隔离 |
| **Lane** | BatonSession 原生的持久串行任务线；主线 identity 为保留值 `main`，支线使用 `hl_` identity，可由人或 Plugin 发起，并可跨多个 HarnessTarget 接力 |
| **HarnessSession** | Harness 在某个 `Lane × HarnessTarget` 下持有的持久原生执行会话；缺失只影响恢复优化，不阻止 Lane 继续 |
| **HarnessSessionBinding** | 当前 `Lane × HarnessTarget` 到 HarnessSession 的可重建连接；由 Adapter 在 identity 可知时主动发布 |
| **HarnessSessionHandle** | 进程内调用路由句柄；不能持久化，也不能代替 HarnessSession identity |
| **Input** | Controller 拥有的待处理刺激；prompt 带 user/plugin source、稳定 message/turn identity 和可查询消费状态 |
| **HarnessInvocation** | `draft` / `harness` 调用的 Core-owned 持久执行记录；关联 Plugin、Resource、Input、Lane、Turn 与结果，不是 Plugin API 或授权对象 |
| **Delivery Attempt** | 一次已准入 Input 向 Harness 投递的持久记录；先 `prepared` 再 dispatch，无法证明结果时保留 `uncertain` |
| **Turn** | 一段有始有终的 Harness 活动；driven/observed 是发起角色，不影响“必须收口”的契约 |
| **Event** | append-only 的最小执行事实；Event Ledger 是 Session 执行与感知历史的真相源 |
| **Interaction** | 需要外部参与者给出结果后才能继续的持久待决对象；Controller 拥有 requested/answered/cancelled 生命周期 |
| **Context delivery** | 有 owner/key 的 ContextSource 被组装为 Snapshot，并向具体 HarnessSession 交付；Receipt 才推进 Epoch |
| **Projection** | Event reduce 得到的派生展示快照；不是新的事实来源 |

`Event.scope` 回答事实属于哪条 ledger，`Event.source` 回答谁报告事实，Lane、HarnessTarget、
HarnessSession 和 Turn 则是执行坐标。这些维度正交，不能从 Harness 名、alias 或 wire key
猜测彼此。

Baton 签发的 Event、Interaction、Context Snapshot/Epoch、Session、Turn、Message、Tool Call
和 Attempt 使用带前缀的稳定 ULID。HarnessTarget、PluginInstance 等配置对象使用各自作用域内
的稳定 ID。fork 复制逻辑对象时保留对象 ID，进入 child ledger 的 Event envelope 重新签发
`eventId`；详细语义见 [resume 与 fork](./resume-fork.md)。

## 3. 整体设计

```text
                         Baton host process
┌──────────┐ intent   ┌──────────────────────────────────────┐
│ chat-tui │─────────▶│ Controller / Session / Event Ledger  │
│          │◀─────────│ Context / Interaction / Projection   │
└──────────┘ render   │ Plugin Manager / Runner supervision  │
                     └──────────────┬───────────────┬─────────┘
                                    │               │
                              stable contract       │ IPC
                                    ▼               ▼
                            Harness Adapter     Plugin Runner
                                    │               │
                                    ▼               ▼
                                 Harness       Connector / domain
```

host 主线程拥有 stdin、焦点、Controller、SessionStore、Plugin Manager 和展示快照。render、键盘
handler 与同步 getter 只读内存，不执行文件、网络、Git、Package import 或 Plugin 回调。
I/O 使用 async API；三方 Plugin 按活动 Binding 运行在独立 Runner 进程，Harness 进程或 SDK
生命周期由对应 Adapter 持有。

进程边界按故障与 owner 划分，不按页面区域划分。chat-tui 的 composer、timeline、footer、
sidecar 只是 surface 订阅边界，共享一条终端焦点和一条 host event loop。进程关闭按 owner
反向进行：停止接收 intent → cancel/close Harness → 关闭 Plugin Binding/Runner → flush Session
→ destroy renderer。

内核只有一条双向流水线。这里仅给出拓扑；admission、Context、Attempt、Interaction 和终态的
顺序以 [工作流](./workflow.md) 为准。

![Baton 内核双向流水线](./kernel-pipeline_v1.svg)

## 4. 关键不变量

### 4.1 单通道真相

一切可恢复、可展示的执行事实都经过：

```text
Event → append → broadcast → reduce → Projection
```

live、resume 和自愈使用同一条 reduce 路径。Adapter、Controller 或 TUI 都不能再开一条
per-turn callback 或直接改视图状态的旁路。Plugin Resource 和外部系统可以拥有各自领域事实，
但不能冒充 Session Event Ledger。

### 4.2 终态封闭，未知悲观

每个被接受的 Turn 必须恰好逻辑收口一次；正常结束、wire error、子进程退出、transport close
和 cancel 都必须报告或合成终态。物理终态可以重复或迟到，Controller 按 Baton turn ID 幂等
finalize。

内部状态使用封闭词表，Adapter 在边界归一 Harness 的开放值；未知终态不能乐观映射为成功。
原始协议保留在 Event `raw`，未知通知进入有界诊断而不是静默丢弃。

### 4.3 Core 无 Harness 分支

Harness 差异只能存在于 Adapter、Definition、Inspector 和 Capability。Session、Event Store、
reduce、Projection 与 chat-tui 不出现 `if harness === ...`。新增 Harness 默认只修改：

```text
src/harness/<harness>/
src/harness/registry.ts
src/harness/ids.ts
```

只有被多个 Harness 共同印证、且确实改变稳定契约的能力，才可提升为新的 Capability 或内核概念。

### 4.4 事实先于副作用和投影

获准执行的 prompt Input 先成为 BatonSession 事实，再尝试 dispatch；Delivery Attempt 先持久化 `prepared`，
再调用 Adapter。`ReconcileContext` 调用对应的 Interaction 或 HarnessInvocation 先持久化，
再产生 UI 或执行副作用。Context Snapshot 只说明准备送什么，只有
DeliveryReceipt 才证明 transport 已接受。无法证明副作用是否发生时保留 `uncertain`，不盲目
重投。

### 4.5 长期 loop 与执行小闭环分层

Baton core 不内建 Requirement、Deployment、Review 或通用 LoopRun。领域 Plugin 拥有 Resource、
Connector、完成条件和 reconcile；Harness Plugin 拥有 agent 内部开发约束。Plugin 用 `ask` /
`confirm` 组织 human-in-the-loop，用 `draft` 交给用户修改，用 `harness` 直接执行。Core 把这些
能力调用物化为持久 Interaction 或 HarnessInvocation，并让最终 Input 继续走统一的 Context、
Permission、Attempt 和 Harness routing 主路径。Plugin 决定业务步骤，Core 始终拥有授权与执行。

### 4.6 单 Ledger、多 Lane

一个 BatonSession 仍只有一份 `session.jsonl`。`seq` 只表示 append 的全局观测顺序，
不表示跨 Lane 因果；因果由 `turnId`、`parentEventId` 和领域 identity 表达。新的
Harness 执行事实必须带 `laneId`；缺失该坐标的事件不属于当前 ledger 契约。

BatonSession 的保留 Lane ID `main` 是默认主线（概念上的 lane0），其它 Lane 是可异步推进的
支线任务。Lane 的发起者可以是人或 Plugin，`createdFor` 与 `parentLaneId` 只记录创建来源，不定义
后续调用权限；主/支角色只由 Lane ID 是否为 `main` 判断。每个 Lane 同时最多一个 driven Turn，
Lane 内即使切换 HarnessTarget 也保持串行；不同 Lane 可以并行。支线有独立并发上限，不能占住
主线 admission。新 Lane 的原始事件仍在 ledger 中可审计，默认 timeline 只展示其卡片与
TurnSummary。

## 5. 演进规则

判断一个新能力落点时依次问：

1. 它的事实由谁拥有，生命周期由谁收口？
2. 它是单个 Harness 的协议差异，还是多个 Harness 共享的稳定语义？
3. 它是否需要持久身份、恢复和对账，还是仅是短寿命 signal/view？
4. 是否可以通过现有 Input、Interaction、Event、Context 或 Capability 表达？
5. 提升内核后，能否保持新增 Harness 不修改 Session/store/projection/chat-tui？

signal 只提示重新读取权威状态，不能冒充 Event；Board 更新、Context 已交付和 Harness 已被唤醒
是三个独立事实。同一输入的批量 fan-out / 结果策展和跨 Session 主线/草稿收录留在
[Backlog](./backlog.md)，不提前向 Plugin 暴露 Harness 句柄。

## 6. References

- [工作流](./workflow.md) — Input 发起、Harness 执行、事件投影与 Interaction 闭环
- [Harness](./harness.md) — Target、Session、Adapter、Capability 与扩展契约
- [Plugin](./plugin.md) — Resource/Controller、Runner、Board、Context 与长期 loop
- [审批生命周期](./approval-lifecycle.md) — permission、授权方与 auto-review 回执
- [Session Paths](./session-paths.md)、[resume 与 fork](./resume-fork.md) — 会话分支、恢复与收录
- [日志体系](./logging.md) — Baton、Harness 与 Plugin 的结构化诊断
- [Backlog](./backlog.md) — 有意识暂缓的能力和启动条件
