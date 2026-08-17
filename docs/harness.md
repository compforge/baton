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
harness wire ── Adapter ──▶ Baton Event ── Projection ──▶ chat-tui view
harness wire ◀─ Adapter ◀── Baton action ◀─ Controller ◀── chat-tui intent
harness verb ─ Adapter lowering ─▶ InteractionDraft ─ OpenInteraction ─▶ Core
```

Adapter 是唯一同时理解原生协议与 Baton 契约的模块。Baton 采用“稳定共同语义 + capability +
raw 保真”，不要求把所有 Harness 压成最低公分母，也不把单家方言提升为核心概念。

## 2. 身份与对象

### 2.1 Definition 与 Target

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

### 2.2 Lane

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

### 2.3 Session、Binding 与 Handle

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

## 3. Adapter 生命周期

稳定核心接口保持很小：

```ts
interface HarnessAdapter {
  readonly harness: string;
  readonly capabilities: AdapterCapabilities;
  open(options, sink, bindingSink): Promise<HarnessSessionHandle>;
  sendTurn(handle, input): Promise<SendTurnReceipt>;
  cancel(handle): Promise<void>;
  close(handle): Promise<void>;
}
```

### 3.1 open

`open` 在 BatonSession cwd 中建立或恢复 HarnessSession，并长期绑定 Event sink。Adapter 可以在启动期完成 initialize、
hook trust、配置读取或原生 resume；这些 I/O 必须有显式 timeout 和失败清理。身份如果只能从
首个原生事件获得，则在获得时立即发布 Binding。

setup 不自成 Turn。冷启动由某个 Queue item 触发时，期间打开的 Interaction 归属对应 Turn；
open 尚未返回 handle 前创建的进程、query 或连接必须由 Adapter 自己在失败路径回收。

### 3.2 sendTurn

`PromptInput` 携带 Baton `turnId`、`messageId`、闭合的 prompt blocks，以及可选 Context
side-channel。Adapter 必须在 admission 前拒绝不支持的 block 类型，不能用文本化 helper 静默
丢弃内容。

`sendTurn` 只返回 admission 结果：

- `accepted/new_turn`：Adapter 接受开启新 Turn 的责任；
- `accepted/steer`：Adapter 接受向匹配的当前 Turn 投递；若原生 Harness 还有队列，
  后续用 user message delivery state 报告实际应用或失败；
- `rejected`：没有接受，Controller 可以安全排成 follow-up。

有活跃 Turn 时，Adapter 不得擅自并行开启新 Turn。throw 只允许发生在接受责任之前；accepted
后的失败通过 Event sink 报告终态。

Controller 在实际调用 `sendTurn` 前后发送 `harness.inbound.before/after` Hook。方向沿
Human→Harness 定义，因此 Core 向 Harness 投递属于 inbound。新 Turn 的
before 位于持久 Delivery Attempt 的 `prepared` 与 `dispatching` 之间；after 携带 Adapter admission
的 `accepted/rejected/error` 结果，但不等待 Turn 终态。steer 也使用相同 notification shape，
其 attempt identity 只关联这次 same-turn send。

### 3.3 cancel 与 close

`cancel` 只是请求中断，确认以最终 `idle/cancelled` Event 为准，发出后仍接收在途 update。
若 Harness 的 pending steer 在 interrupt 后无法继续，Adapter 以 `cancelPendingSteers:"requeue"`
把这项所有权约束交给 Controller；Controller 会在 cancel 前收回仍未 applied 的 Input。能自行继续
原生队列的 Adapter 不声明该策略，后续仍以 delivery lifecycle 为准。
`close` 释放 Adapter-owned 进程、query、订阅和句柄；若仍有已接受 Turn，必须先报告或合成终态。

## 4. Capability

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

## 5. Event 与 Interaction 契约

### 5.1 事件归一

Adapter 只提交 Event draft；宿主按当前 Binding 在可信边界补 `source:harness`、Lane、HarnessTarget、
HarnessSession 与 Session scope。原生 wire 存入 `raw`，不能让 Adapter 自报执行归属。

Harness output 先由 BatonSession 同步 record 到 Event Ledger 并 reduce Projection，再以带
`eventId/seq` 的 record 通知 `harness.outbound.before/after`。Ledger 不分发事件；Hook 不承担准入，
不能把 Plugin 延迟传播到 EventSink；它需要动作时
通过 Verb 请求 Core。Hook 失败 fail-open，不改变 Adapter 的 EventSink 契约。

稳定事件覆盖 message、thought、tool、diff、plan、task、usage、状态和短寿命 notice。按稳定 ID
upsert，completed 全量内容是流式丢包的自愈点。Plan entry 必须有 Plan 内稳定 ID；Adapter 保留
原生 ID，原生完整快照没有 identity 时按稳定内容派生。开放 wire enum 在 Adapter 边界保守归一；
未知值不进入核心封闭状态。

`context_window_update` 是最近一次主/root 模型请求的完整快照，payload 固定包含：

- `modelSelection`：用户或 Target 选择的模型，用于切 model 后立即判旧快照失效；
- `effectiveModel`：Harness 路由实际命中的模型（能观测时提供）；
- `usedTokens`：该次请求的输入侧 token，包含 cache read/write，不含 output；
- `capacityTokens`：同一条已解析模型路由的有效 context window。

Adapter 只有在占用与容量能严格配对时才发事件，不能先发 size-only 再补 used，也不能把成本塞进
该快照。Projection 同时按 `HarnessTarget` 和 `Lane × HarnessTarget` 保存；面向当前会话的展示读取
主 Lane，避免 side Lane 覆盖。旧 `context_usage_update` 只用于历史 Ledger replay，新 Adapter 不再
产生该事件。

### 5.2 Turn 终态

每个被 `new_turn` 接受的 Turn，在正常结束、wire fatal error、子进程退出和 transport close
路径都必须报告或合成一次 `state_update(idle)`；错误先发 `_baton_error_update`。重复或迟到的
物理终态允许存在，Controller 按 Baton turn ID 幂等 finalize。

Harness 自发活动由 Adapter 铸造普通 Turn，以 Harness 来源的 running/idle 划界。它没有对应
Queue item，因此不占用 Queue；Turn 本身没有另一种 role。

### 5.3 Interaction

Harness 的 request approval、request user input 等原生 verb 属于各家协议。Adapter 先把它们
lowering 成闭合的 `InteractionDraft`，再通过 `OpenInteraction` typed Core port 等待 result。
Core 签发 `interactionId` 和 requester，持久化 requested/answered/cancelled；Adapter 不得自行发
完整生命周期 Event，也不能把原生 DTO 当作通用消息上送。Interaction 的执行坐标和原生请求留在
envelope context/raw，不能污染稳定 payload。

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

1. 在 `src/harness/ids.ts` 注册 canonical ID 与 aliases；
2. 实现 `src/harness/<name>/adapter.ts`，集中所有 wire lowering/normalization；
3. 在 `registry.ts` 注册 Definition、工厂、session key、可选 probe 和 Inspector；
4. 仅声明已经实现并有契约测试的 Capability；
5. 覆盖 open 失败、accepted 后失败、cancel、transport close 和迟到终态；
6. 若支持原生历史，Inspector 必须只读并生成完整 Boundary；
7. 用参数化测试证明 Store、Projection、Interaction 与队列无需 Harness 分支。

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
