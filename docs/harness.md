# Baton Harness

Harness 是 Codex、Claude Code 等智能执行环境的统一边界。本文定义 Target、Session、Adapter、
Capability、事件归一和外部会话纳管的公共契约；具体协议差异见
[Codex](./harness/codex.md)、[Claude Code](./harness/claude-code.md) 与
[DeepSeek Harness](./harness/deepseek-harness.md)。端到端用户时序见
[工作流](./workflow.md)。

## 1. 抽象目标

Baton 需要保留各家 Harness 的原生体验，同时避免其 DTO、状态枚举和 Session 语义穿透到
Controller、Store、Projection 或 chat-tui。边界因此分为三层：

```text
harness wire ── Adapter ──▶ HarnessEvent ── Core commit ──▶ Event ── Projection ──▶ chat-tui view
harness wire ◀─ Adapter call ◀─ HarnessInput ◀─ Controller ◀── chat-tui intent
harness verb ─ Adapter lowering ─▶ InteractionDraft ─ OpenInteraction ─▶ Core
```

Adapter 是唯一同时理解原生协议与 Baton 契约的模块。Baton 采用“稳定共同语义 + capability +
raw 保真”，不要求把所有 Harness 压成最低公分母，也不把单家方言提升为核心概念。

## 2. Harness IO 与公共端口

`Harness IO` 表示 Core ↔ Harness 实时执行的两个语义方向：Input port 把一条持久工作交给 Harness，
Output port 接收 Harness 的流式观察。`HarnessInput` 与 `HarnessEvent` 直接表达这两个方向，不再通过
inbound/outbound 组合命名。

Harness 公共 IO 只定义两个事实：Core 拥有等待 Harness 处理的 `HarnessInput`，
Adapter 持续产生已归一但尚未提交的 `HarnessEvent`。Core 为 HarnessEvent 补齐可信坐标、
`eventId/seq` 并写入 Ledger 后，它才是 Baton `Event`。Adapter function call、即时返回、
delivery attempt 和 Hook payload 只是这两个事实的传输与观察机制，不进入 Harness IO 概念模型。

### 2.1 HarnessInput 与 Adapter input

`HarnessInput` 是 Core-owned 的持久工作对象，不是 Harness wire DTO。它把一次准备交给 Harness 的
prompt 工作稳定表达为五个维度：

- identity：`messageId`，以及预留或实际承载它的 `turnId`；
- routing：`HarnessTarget` 与 `laneId`；
- content：闭合的 `PromptBlock[]`；
- provenance：user/Plugin source，以及可选的 ViewInput、HarnessInvocation、ProposedPlan 因果；
- lifecycle：Queue/admission status、`prompt|steer` delivery 与独立的 delivery outcome。

Queue、recall、steer、cancel 和恢复都操作同一条 HarnessInput。真正调用 Adapter 时，Controller
只把 HarnessInput 中 Harness 需要的 `turnId`、`messageId`、blocks 与可选 Context side-channel
降低为 `sendTurn` 调用参数。该参数 shape 是 Adapter 机制，不是第二种 Input；Queue 状态、
Plugin identity 和持久化细节不穿透 Harness。

### 2.2 HarnessEvent

Harness output 是 Adapter 经 `HarnessEventSink` 持续提交的归一化 `HarnessEvent`：

| 类别 | 稳定语义 | 典型内容 |
|---|---|---|
| 内容 | Human 可消费的回答与思考 | message、thought |
| 执行 | 有身份和生命周期的工作与产物 | tool call、diff/effect、plan、task |
| 运行态 | Harness 当前执行与容量事实 | run state、usage、context window、available command/config |
| 回执与诊断 | 需要 Core 持久处理的结果 | input delivery、approval review、notice、error |

宿主在可信边界补齐 HarnessTarget、Lane、Session 与 Turn 坐标，签发 `eventId/seq`，
再作为 Baton Event record + reduce。原生 wire 可以旁路进入 native trace，并在 Event `raw` 中保真，
但不能直接成为 Projection 或
Plugin API。UI grouping、Parallel 区域和卡片布局都是 Event 的 Projection，不属于 Harness output
vocabulary。

HarnessEvent 按稳定 ID upsert，字段省略表示不变、`null`/空集合表示清除、chunk 表示追加；completed
全量内容是流式丢包的自愈点。开放 wire enum 在 Adapter 边界保守归一，未知值不进入 Core 封闭状态。
context window 只有在本次占用与容量能严格配对时才作为完整快照输出，避免跨模型拼接数据。

### 2.3 其它 Adapter 端口

并非所有 Harness → Core 返回都属于 output stream：

- `SendTurnReceipt` 是 Input port 的同步 admission 结果，只说明 Adapter 是否接受 new turn/steer；
- `InteractionDraft` 是 Harness 原生 verb 对 typed decision 的请求，经 `OpenInteraction` 进入 Core；
  Core 签发 identity 并持久化 requested/answered/cancelled，Adapter 只等待 result；
- `HarnessSessionBinding` 经 Binding sink 发布原生 Session identity 与 resume state；
- Inspector 是外部 HarnessSession 的只读观察端口，不参与 live IO。

这些名称是 Adapter 接口中的返回类型或独立端口，不进入 Harness IO 概念模型。
它们各自拥有不同生命周期，不为了输入/输出形式对称而统一包装成 Event。

### 2.4 Hook 如何观察 Harness IO

Plugin Hook 不直接接收完整 HarnessInput、HarnessEvent 或 Event payload，只获得边界所需的只读引用：

- `harness.input` 在 Adapter 调用前 inline 发送 `HarnessInputDispatch`；
- `harness.output` 在 HarnessEvent 提交为 Baton Event 后 deferred 发送 `BatonEventReference`。

Adapter admission receipt 和后续 delivery outcome 仍由 Attempt、Input 与 Snapshot 表达，不另建 Hook
stage。Hook 只能观察并通过 Verb 请求新动作，不能替换 Input、拦截 output 或成为事件总线。

### 2.5 什么进入公共 output vocabulary

Baton 只预置能跨 Harness 保持同一 identity、owner、生命周期和 replay 语义的 output。单家协议字段
先留在 Adapter/raw；至少两家反复需要且能共享完整契约时，再提升为 Event、Capability 或 Interaction
kind。是否需要独立 UI 不是提升 Core 概念的理由，是否需要被持久化、恢复、跨 Harness 消费才是。

## 3. 身份与对象

### 3.1 Definition 与 Target

`HarnessDefinition` 是运行时注册的实现定义，包含 canonical ID、alias、持久化 wire key、展示
信息、Adapter 工厂、可选 Target probe 和 Session Inspector。

`HarnessTarget` 是 Baton 配置和调度侧的一份具体目标：

```ts
interface HarnessTarget {
  readonly id: string;
  readonly harness: string;
}
```

同一 Harness 可以有多个 Target。模型、effort 和 mode 偏好按 `harnessTargetId`
共享；Binding、原生 Session、Context 水位和执行投影则按 `Lane × HarnessTarget` 隔离。
不能按 Harness 名共享或反推任何一层 identity。
未知 Target fail closed，不从名称形状猜实现。

用户配置同样以 Target id 为键：根配置只索引 Target，Target 的 `harness` 选择
`HarnessDefinition`，其余启动字段由对应 Harness 配置模块验证并 lowering 为 Adapter 依赖。
因此根 `BatonConfig` 不随 Harness 增加而堆积 provider 方言，Adapter 工厂也不会收到其它 Target
或全局配置。Harness 名和 alias 只帮助用户选择该家的默认 Target，不能替代 Target identity。

```yaml
defaultTarget: codex
targets:
  codex:
    harness: codex
    command: [codex, app-server]
  dsh-prod:
    harness: dsh
    command: [dsh-jsonrpc-agent, /absolute/path/to/cordis.yml]
    model: prod
```

Target probe 只发现 model、effort、command 等静态目录，不创建 HarnessSession，也不借
`Adapter.open()` 制造隐形执行状态。

### 3.2 Lane

`Lane` 是 BatonSession 原生的逻辑任务线。主线使用保留 ID `main`，支线 ID 使用 `hl_` 前缀。
它拥有创建来源，以及按 HarnessTarget 保存的 HarnessSession binding；原生 Session 因恢复失败
而重建时，Lane identity 不变。Lane 不绑定某一个 Target，可以在相邻 Turn 之间切换 Harness
接力。

BatonSession 的 `main` Lane 是默认主线；其它 Lane 表达异步支线。Lane 可以由人或 Plugin 发起，
`createdFor` 与 `parentLaneId` 只记录创建事实，不决定它是不是主线，也不限制后续使用者。
HarnessInvocation 用 `laneId` 继续既有 Lane；`newLane:true` 才在准备执行时创建
`createdFor:harness_invocation` 支线。

每个 Lane 同时最多一个 active Queue run。多个 Lane 可并行，因此一个 Target 可同时有多个 Adapter、
Handle 和原生 Session；Binding 索引必须使用 `(laneId, harnessTargetId)`，不能只用其中一个。

### 3.3 Session、Binding 与 Handle

三个相似对象承担不同生命周期：

| 对象 | 生命周期 | 能否持久化 |
|---|---|---|
| `HarnessSessionIdentity` | Harness 在 `Lane × HarnessTarget` 内拥有的稳定原生会话身份 | 是 |
| `HarnessSessionBinding` | 当前 `Lane × HarnessTarget` 到原生 Session 的可重建连接和 resume state | 是 |
| `HarnessSessionHandle` | 当前 Adapter 实例内的调用路由 | 否 |

Adapter 在 identity 首次可知或 checkpoint 更新时，通过 `HarnessSessionBindingSink` 主动发布
Binding。Controller 不从 handle、事件或 `hs_` 等 ID 形状猜 identity。

`HarnessLaunchSnapshot` 冻结一次 open 实际使用的 Target、Session cwd、model 与 effort，用于解释已发生
的 Delivery Attempt；之后配置变化不能回写历史。`HarnessResumeState` 是 Adapter-owned 的
版本化 opaque 数据，Baton 只保存并在下次 open 原样回传。

## 4. Adapter 生命周期

稳定核心接口保持很小：

```ts
interface HarnessAdapter {
  readonly harness: string;
  readonly capabilities: AdapterCapabilities;
  open(options, eventSink, bindingSink): Promise<HarnessSessionHandle>;
  sendTurn(handle, input): Promise<SendTurnReceipt>;
  cancel(handle): Promise<void>;
  close(handle): Promise<void>;
}
```

### 4.1 open

`open` 在 BatonSession cwd 中建立或恢复 HarnessSession，并长期绑定 HarnessEvent sink。Adapter 可以在启动期完成 initialize、
hook trust、配置读取或原生 resume；这些 I/O 必须有显式 timeout 和失败清理。身份如果只能从
首个原生事件获得，则在获得时立即发布 Binding。

setup 不自成 Turn。冷启动由某个 Queue item 触发时，期间打开的 Interaction 归属对应 Turn；
open 尚未返回 handle 前创建的进程、query 或连接必须由 Adapter 自己在失败路径回收。

### 4.2 sendTurn

`sendTurn` 的调用参数携带 HarnessInput 的 `turnId`、`messageId`、闭合 prompt blocks，
以及可选 Context side-channel。Adapter 必须在 admission 前拒绝不支持的 block 类型，
不能用文本化 helper 静默丢弃内容。

`sendTurn` 只返回 admission 结果：

- `accepted/new_turn`：Adapter 接受开启新 Turn 的责任；
- `accepted/steer`：Adapter 接受向匹配的当前 Turn 投递；投递进度按 `steering`
  descriptor 的约定报告（见下）；
- `rejected`：没有接受，Controller 可以安全排成 follow-up。

有活跃 Turn 时，Adapter 不得擅自并行开启新 Turn。throw 只允许发生在接受责任之前；accepted
后的失败通过 HarnessEvent sink 报告终态。

每个 accepted/new_turn 在正常结束、wire fatal error、子进程退出和 transport close 路径都必须
报告或合成 `state_update(idle)`；错误先发 `_baton_error_update`。重复或迟到的物理终态可以存在，
Controller 按 Baton turn ID 幂等 finalize。Harness 自发活动也用普通 running/idle Turn 划界，
只是没有对应 Queue item。

支持 same-turn steer 的 Adapter 必须声明 `steering` descriptor，把能力差异压缩成两个声明，
而不是散落在各家的控制流里：

- `deliveryTracking`：`explicit` = 接受后必须经一等事件 `input_delivery_update`
  报告 `applied`（已写入模型上下文）/ `failed`（明确丢弃），回执允许迟到于 Turn 收口；
  `ack-only` = 接受即应用，没有后续回执，由 Core 在 accept 时合成 `applied`；
- `cancelOwnership`：cancel/interrupt 后原生队列里未应用的 steer 是否仍可达。
  `survives` = Harness 继续拥有并报告回执；`unreachable` = 不可达，Controller 会在
  发 cancel 前把它们收回 Baton Queue 并重放为 follow-up。

投递事实是 Input 的一等状态（`HarnessInput.deliveryOutcome`），不再寄生
`user_message.deliveryState`（该字段仅剩老 ledger replay 兼容）。

Controller 在实际调用 `sendTurn` 前发送 inline `harness.input` Hook。新 Turn 的通知位于持久 Delivery
Attempt 的 `prepared` 与 `dispatching` 之间；steer 使用相同 `HarnessInputDispatch`，其 attempt identity
只关联这次 same-turn send。Adapter admission 的 `accepted/rejected/error` 回执继续更新 Attempt/Input
状态，不再作为第二个 Hook 阶段。

### 4.3 cancel 与 close

`cancel` 只是请求中断，确认以最终 `idle/cancelled` Event 为准，发出后仍接收在途 update。
若 Harness 的 pending steer 在 interrupt 后无法继续，Adapter 以
`steering.cancelOwnership: "unreachable"` 把这项所有权约束交给 Controller；Controller 会在
cancel 前收回仍未 applied 的 Input。能自行继续原生队列的 Adapter 声明 `"survives"`，
后续仍以 `input_delivery_update` 回执为准。
`close` 释放 Adapter-owned 进程、query、订阅和句柄；若仍有已接受 Turn，必须先报告或合成终态。

## 5. Capability

公共设计采用“小核心 + 可选能力”。descriptor 用 `{ supported: true }` marker，行为由对应接口
承担；契约测试保证“声明即实现”。当前能力族包括：

| 能力 | 语义 |
|---|---|
| prompt block | image、audio、embedded resource、resource link 的独立支持声明；text 为基础能力 |
| config | model、effort、mode 等完整 Session config 快照 |
| compact | 用 Harness 原生机制压缩当前会话 |
| sync | 随 `sendTurn` side-channel 交付 Baton Context |
| reconcile | 查询 Harness 当前权威运行态，供 stall 恢复 |
| approval routing | 报告实际审批由用户还是 delegated reviewer 处理 |
| textgen | 无状态的一次性结构化生成；不创建 HarnessSession/Turn，供会话标题等旁路工具降级调用 |
| interactions | permission、question、elicitation 等原生交互 |
| commands | 动态 Harness command 发现与执行 |

Capability 表达是否支持，不表达 Harness 名称。Controller 只做 feature detection 和优雅降级，
不能写 provider 分支。若只有一家 Harness 需要某种行为，先留在其 Adapter；至少两家共同印证且
owner、生命周期和恢复语义一致时，才考虑提升公共 Capability。

## 6. 外部 HarnessSession 纳管

Adapter 负责 live 执行，`HarnessSessionInspector` 负责只读观察已经存在的原生 Session。Inspector
不能 open、resume 或修改会话；它返回：

- 稳定 HarnessSession identity；
- cwd、title 等发现信息；
- 归一化完整 Turn 历史；
- `HarnessHistoryBoundary`，覆盖完整语义前缀。

纳管流程是：

```text
reference
  → read-only inspect
  → HarnessHistorySnapshot
  → adopt as BatonSession
  → ordinary resume / fork path
```

裸 Session ID 同时只读探测已注册 Inspector；多家命中时要求 `cx:`/`cc:` 等显式限定。adoption
后 `adoptedFrom` 永远指向最初来源，当前 Binding 可以重建。再次显式接入同一原生 Session 时，
只允许按完整 `HarnessHistoryBoundary` 对账既有前缀并补尾；分叉必须失败，不能静默改写
BatonSession 历史。

## 7. 新增 Harness

新增实现按以下顺序：

1. 注册 canonical ID、aliases、Target 配置 lowering 与 Definition；
2. 实现 Input port：`open/sendTurn/cancel/close`、PromptBlock admission 和 `SendTurnReceipt`；支持 steer
   时声明 delivery tracking/cancel ownership，并用 `input_delivery_update` 报告显式回执；
3. 实现 Output port：只把已支持的原生观察归一为公共 HarnessEvent，未知 wire 保留 raw/diagnostic；
4. 按需实现独立端口：Interaction lowering、Binding 发布、Capability、Target probe 与 Inspector；
5. 覆盖 open 失败、accepted 后失败、cancel、transport close、迟到 Turn 终态和迟到 delivery receipt；
6. 若支持原生历史，Inspector 必须只读并生成完整 `HarnessHistoryBoundary`；
7. 用参数化测试证明 Store、Projection、Interaction 与 Queue 无需 Harness 分支。

自检 diff 默认只落 `src/harness/<name>/`、`registry.ts`、`ids.ts` 和相应 tests。若修改
Session、reduce、Projection 或 chat-tui，先判断暴露的是公共概念缺口，还是 Adapter 尚未收住
单家方言。

## 8. References

- [Codex Adapter](./harness/codex.md)
- [Claude Code Adapter](./harness/claude-code.md)
- [工作流](./workflow.md)
- `src/harness/adapter.ts` — 接口与 Capability 的代码事实来源
- `src/harness/registry.ts`、`src/harness/target.ts` — Definition 与 Target
- `src/harness/native-session.ts` — Inspector、Snapshot 与 adoption
- `tests/capabilities.test.ts`、`tests/adapter-mapping.test.ts` — 公共契约测试
