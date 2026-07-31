# Backlog：暂缓能力与演进触发条件

有意识推迟的能力。每条记录“是什么、为什么值得做、什么条件下启动”，避免过早实现与彻底
遗忘。条目成熟后进入对应权威文档和实施计划；尚未形成稳定模型的问题也留在这里，不再另建
按版本命名的设计草案。

## 受控的自动 Harness Work

当前 Plugin Controller 只能返回 `proposed-input`，经用户确认后进入普通 Input/Attempt 主路径。
未来可以允许 Controller 请求 Baton 自动启动或继续 Harness，但 Plugin 仍不能持有 Adapter、
Harness 进程或 SDK 句柄；路由、权限、成本、并发、取消、Context 和结果持久化继续由 Baton
负责，并复用已有 Delivery Attempt 与 `uncertain` 对账语义。

**触发条件**：真实长期 loop 证明 Resource 必须在没有用户 submit 时继续 Harness，且该需求
无法由 Source、Watch、cron、requeueAfter、Connector 或用户确认的 Proposal 表达。

## Daemon 与关闭 TUI 后的推进

当前 Plugin Runner、Source 和 reconcile queue 跟随 Baton host 生命周期。若关闭 TUI 后仍要
准时消费 webhook、cron 或长期任务，需要让 daemon 复用同一 Event/Resource/Attempt store 和
恢复协议，而不是另造 notifier 或后台状态机。

**触发条件**：有明确产品场景要求 TUI 关闭后仍满足可量化的实时性或准时性，并且一次启动补扫
不足以满足要求。

## 多 Harness 并行与结果收录

当前同一 BatonSession 的 driven Turn 串行，Harness 切换表达上下文接力。并行探索应先建立
显式 draft Session、写令牌和 Context import，再考虑同时 dispatch 多个 Harness；不能把多路
Event stream 直接 merge 成一条正典历史。

**触发条件**：`session-paths.md` 的 draft/elect/import 主线语义稳定，并且真实任务持续需要同一
输入并行交给多个 Harness 后再由用户或 reviewer 收录结果。

## Capability 组合式 runtime preparation

tutti 把 agent 启动前准备抽成独立模块，用 `DeploymentProfile + CapabilityPack` 一次性组合 system policy、skills、环境变量、harness 本地文件与 session cleanup。核心洞察不是抽包，而是**一项能力的 prompt、skill 和 env 必须一起启停**，否则三套配置各自漂移。参考 tutti `packages/agent/runtimeprep/`。

**触发条件**：baton 开始做 skill 注入、browser/computer 类 capability，或同一套 adapter 需要部署到多种宿主环境时。

## Open URL Interaction 与宿主打开能力

Harness 或其子进程不能假设自己能直接访问宿主桌面。Baton 包装 Codex 后，npm 等 CLI 即使
输出浏览器认证 URL 并调用系统 `open`，也可能无法连接 macOS LaunchServices；远程或 headless
Harness 下更不存在可直接打开的本地图形环境。

后续把打开外部 URL 建模为显式的 `open-url` Interaction：请求方只贡献 URL、用途和等待语义，
Baton 负责持久化并向用户展示，由宿主能力在用户确认后打开并回传明确结果。Harness 不直接
调用桌面命令，也不能把“子进程成功启动”当作用户已完成认证；宿主无法打开时仍保留可复制的
URL，让流程可见且可恢复。

**触发条件**：Baton 开始正式支持需要 OAuth / 浏览器认证的 CLI 工作流，或 Harness 需要在
远程、headless 与本机桌面宿主之间保持同一套交互语义时。

## Opaque reference（NodeRef / ReferenceHandle）

tutti 把跨来源引用统一成 `NodeRef { sourceId, nodeId }`，`nodeId` 对聚合层完全不透明；复杂产物用懒解析的 `ReferenceHandle`，避免把整个 artifact 提前塞进 prompt。参考 tutti `docs/architecture/agent-reference-sources.md`。

与未来的 `mention:// + CLI 回查` 方向一致：mention 的惰性解析要求引用先是“可回查的句柄”，
而不是提前展开的内容本身。

**触发条件**：落地 `mention://` 时对齐该约束；`@` 来源从 BatonSession 扩展到文件、issue、
构建产物时按此建模。

## 基于首轮语义摘要的会话标题

baton v1 直接取第一条真实用户输入的首个非空行作为会话预览和 terminal tab name，确定、即时且零额外成本。后续可参考 OpenCode：首轮提交后异步调用轻量模型生成更短的语义标题，再更新会话列表与 terminal title；生成失败继续使用 v1 预览，不能阻塞用户输入或 harness 执行，用户显式命名仍具有最高优先级。Codex 当前默认标题是运行状态与项目名的组合，不以首问作为标题。

现在引入会增加一次模型调用的成本、延迟与非确定性，而首行预览已满足基本的会话发现和 Otty tab 识别需求。

**触发条件**：实际使用中频繁出现首问过长、包含路径/附件或多行背景，导致 session picker、`@` 候选和 terminal tab 难以区分；且已有稳定、低成本的标题模型可异步调用时。

## Streaming Markdown 的稳定 head / 不稳定 tail

流式回复整体交给 Markdown renderable 时，末尾尚未闭合的 fenced code、列表或表格可能随 token 改变块结构，触发重复解析、高亮和布局重排。后续可把已稳定的 Markdown 前缀与仍在增长的尾块分开：head 保持挂载且不再流式更新，tail 按 code 或 plain text 单独渲染，完成后再合并成最终 Markdown。

OpenCode 的同类尝试能显著减少持续闪烁，但仍可能在消息完成时留下 1–2 次高亮 settle。Baton
已经用单通道投影和通知去重消除了每个事件的重复 view publication；下一步先确认剩余闪烁确实
来自 Markdown 尾块结构，再决定是否引入边界切分。参考 [OpenCode #27897](https://github.com/anomalyco/opencode/issues/27897)
与 [PR #27961](https://github.com/anomalyco/opencode/pull/27961)。

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
EventHandler` 落下 level-based reconcile 主链路；当前宿主约束见
[`plugin.md` §4](./plugin.md#4-resource-与-reconcile-流程)，作者约束见
[`plugin.md` §6](./plugin.md#6-plugin-authoring-约束)。其余 controller-runtime
概念不为 API 对齐而预建，按下面的真实压力分别引入：

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
- **更多 owner / garbage-collection policy**：当前已经支持同 Instance 内单一结构 owner、uid
  固定 incarnation 和级联删除请求。只有真实场景需要多 owner、orphan 或不同 propagation
  policy 时再扩展；普通引用、多方共享或“谁希望继续观察”仍不使用结构 owner。
- **Finalizer**：deletion timestamp 与成功 reconcile 后移除已经落地；当删除前需要多个独立
  清理方各自持有完成水位时，再引入显式 finalizer。需要同时定义卡住删除的可见性、超时、
  强制终止和恢复语义。
- **可配置 RateLimiter**：当前 Manager 的固定指数退避足够。只有不同 Connector 的服务端限流、
  polling 成本或失败恢复窗口明显不同，固定策略造成节流不足或恢复过慢时，才开放受约束的
  Controller RateLimiter 配置，不向 Plugin 暴露原始 workqueue。
- **Leader election**：当前本机多进程靠 Resource reconcile 文件锁保证同 key 不重入。只有
  daemon 或多节点宿主共享同一 BatonSession store、并需要单活 Source/cron 生命周期时，才设计
  Manager 级 leader election；不能把单 Resource 锁直接冒充 leader lease。

这些能力继续沿用 controller-runtime 的既有术语；若 Baton 的身份、持久化或宿主模型导致语义
实质不同，先在 `plugin.md` 写清差异，再决定是否仍应复用该名称。
