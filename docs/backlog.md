# Backlog：暂缓能力与演进触发条件

有意识推迟的能力。每条记录"是什么、为什么值得做、什么条件下启动"，避免两类错误：过早实现（v1 范围膨胀）与彻底遗忘（条件成熟时重新踩一遍调研）。条目成熟进入里程碑后从本文移除；纯设计疑问归 `design.md` §7 开放问题。

## Capability 组合式 runtime preparation

tutti 把 agent 启动前准备抽成独立模块，用 `DeploymentProfile + CapabilityPack` 一次性组合 system policy、skills、环境变量、harness 本地文件与 session cleanup。核心洞察不是抽包，而是**一项能力的 prompt、skill 和 env 必须一起启停**，否则三套配置各自漂移。参考 tutti `packages/agent/runtimeprep/`。

**触发条件**：baton 开始做 skill 注入、browser/computer 类 capability，或同一套 adapter 需要部署到多种宿主环境时。

## Opaque reference（NodeRef / ReferenceHandle）

tutti 把跨来源引用统一成 `NodeRef { sourceId, nodeId }`，`nodeId` 对聚合层完全不透明；复杂产物用懒解析的 `ReferenceHandle`，避免把整个 artifact 提前塞进 prompt。参考 tutti `docs/architecture/agent-reference-sources.md`。

与 M5 的 `mention:// + CLI 回查`（design.md §5.6）方向一致：mention 的惰性解析本就要求引用先是"可回查的句柄"而非内容本身。

**触发条件**：M5 落地 `mention://` 时对齐该约束；`@` 来源从 BatonSession 扩展到文件、issue、构建产物时按此建模。

## 基于首轮语义摘要的会话标题

baton v1 直接取第一条真实用户输入的首个非空行作为会话预览和 terminal tab name，确定、即时且零额外成本。后续可参考 OpenCode：首轮提交后异步调用轻量模型生成更短的语义标题，再更新会话列表与 terminal title；生成失败继续使用 v1 预览，不能阻塞用户输入或 harness 执行，用户显式命名仍具有最高优先级。Codex 当前默认标题是运行状态与项目名的组合，不以首问作为标题。

现在引入会增加一次模型调用的成本、延迟与非确定性，而首行预览已满足基本的会话发现和 Otty tab 识别需求。

**触发条件**：实际使用中频繁出现首问过长、包含路径/附件或多行背景，导致 session picker、`@` 候选和 terminal tab 难以区分；且已有稳定、低成本的标题模型可异步调用时。

## Streaming Markdown 的稳定 head / 不稳定 tail

流式回复整体交给 Markdown renderable 时，末尾尚未闭合的 fenced code、列表或表格可能随 token 改变块结构，触发重复解析、高亮和布局重排。后续可把已稳定的 Markdown 前缀与仍在增长的尾块分开：head 保持挂载且不再流式更新，tail 按 code 或 plain text 单独渲染，完成后再合并成最终 Markdown。

OpenCode 的同类尝试能显著减少持续闪烁，但仍可能在消息完成时留下 1–2 次高亮 settle；因此先消除 baton 当前每个事件的重复 view 通知，再判断是否值得引入 Markdown 边界切分的复杂度。参考 [OpenCode #27897](https://github.com/anomalyco/opencode/issues/27897) 与 [PR #27961](https://github.com/anomalyco/opencode/pull/27961)。

**触发条件**：去重或合并投影刷新后，fenced code、列表、表格的流式输出仍能稳定复现块级闪烁，且问题可确认来自 Markdown 尾块结构重建而非特定终端。

## Plugin Resource ContextSource

Board 展示一份 Resource，不代表目标 Harness 已经收到它的上下文。reqloop 需要把当前 Turn
关联的 Requirement Resource 作为独立 ContextSource，经 ContextSnapshot、DeliveryReceipt 和
ContextEpoch 送达 Harness；同一 BatonSession 可以同时存在多份活跃 Requirement，不能把 Board
上的全部 Resource 无差别注入每个 Turn。

后续需要同时补齐 per-turn ResourceRef / focus 选择，以及 Plugin Proposal 被用户采用后到
Input/Turn 的 Resource provenance。Board presentation 继续只服务人类展示，不作为 Harness
context 的文本事实源。

**触发条件**：reqloop 开始从 Requirement Resource 驱动 Harness 开发时。

## Plugin Controller 对 controller-runtime 的后续借鉴

Baton Plugin 已以 `Resource / Controller / ReconcileRequest / Source / Watches /
EventHandler` 落下 level-based reconcile 主链路；详细对应和差异见
[`plugin.md` §3.2](./plugin.md#32-对-controller-runtime-的借鉴)。其余
controller-runtime 概念不为 API 对齐而预建，按下面的真实压力分别引入：

- **Predicate**：在 EventHandler 前过滤 create / update / delete；当多个 Controller 重复编写
  “generation 未变”“无关 status 字段变化”等空映射逻辑，并且过滤规则可稳定复用时引入。
- **Baton-owned Resource Watches / GenericEvent**：当前 Watches 先覆盖 Plugin-owned 次级
  Resource；当 Plugin-owned 主 Resource 必须由 `Turn` 等 Baton-owned Resource 变化唤醒时，
  让派生索引也产生同一 EventHandler 输入。只有外部 signal 无需 materialize Resource、又不能
  由现有 Source 表达时，再增加 GenericEvent 或 channel Source。
- **FieldIndexer / selector-aware List**：当前 Session-scoped `ResourceClient.list()` 保持简单。
  当 Watches mapper 或 reconcile 对同一引用字段反复全量扫描，并在真实 Resource 数量下形成
  可测瓶颈时，引入由 Baton 维护、随 Resource revision 更新的反向索引；索引仍是派生状态，
  不能成为关系真相源。
- **Owns / OwnerReference / garbage collection**：只有主 Resource 对子 Resource 存在真实控制、
  唯一生命周期 owner 和级联回收要求时引入。普通引用、多方共享或“谁希望继续观察”不使用
  Owns；先明确跨 namespace、删除重建 uid 和 orphan 行为。
- **Finalizer / deletion timestamp**：当 Resource 删除前必须可靠撤销外部订阅、清理远端对象，
  且立即删除会丢失重试身份时引入；需要同时定义卡住删除的可见性、超时、强制终止和恢复语义。
- **可配置 RateLimiter**：当前 Manager 的固定指数退避足够。只有不同 Connector 的服务端限流、
  polling 成本或失败恢复窗口明显不同，固定策略造成节流不足或恢复过慢时，才开放受约束的
  Controller RateLimiter 配置，不向 Plugin 暴露原始 workqueue。
- **Leader election**：当前本机多进程靠 Resource reconcile 文件锁保证同 key 不重入。只有
  daemon 或多节点宿主共享同一 BatonSession store、并需要单活 Source/cron 生命周期时，才设计
  Manager 级 leader election；不能把单 Resource 锁直接冒充 leader lease。

这些能力继续沿用 controller-runtime 的既有术语；若 Baton 的身份、持久化或宿主模型导致语义
实质不同，先在 `plugin.md` 写清差异，再决定是否仍应复用该名称。
