# BatonSession 的 resume 与 fork

## 理念 / 概念

resume 和 fork 都是 **BatonSession 自己的语义**，不依赖任何 harness 的原生 fork 能力：

- **resume**：沿用原 `bs_` ID 重新打开会话，恢复统一逻辑历史；Harness 原生会话只是恢复加速，缺失时从 BatonSession 历史重建上下文（见 [Kernel](./kernel.md) 与 [工作流](./workflow.md)）。
- **fork**：从一个 BatonSession 复制事件历史，得到一个独立的新会话。复制的前缀与源是**同一段逻辑历史**（git-branch 语义），谱系由 `meta.forkedFrom = { batonSessionId, throughSeq }` 表达。fork 是后续"草稿会话"（任务进行中拉草稿并行探索、成果由用户决定收录）的数据层基础，当前先以 CLI 子命令形态提供（`baton fork`），会话内运行中 fork（类 Codex `/side`）留待多 Session Controller。

CLI 也接受 HarnessSession 引用：裸 ID 会同时做只读发现，唯一命中时自动识别；
`cx:<id>` / `cc:<id>` 显式指定 Codex / Claude Code。ID 只是 adoption 入口：
`HarnessSessionInspector` 只读返回 `HarnessHistorySnapshot`，不调用 Adapter.open，也不启动、
恢复或修改该 HarnessSession。Snapshot 的 `observedThrough: HarnessHistoryBoundary` 说明
Inspector 实际观察到哪一段内容前缀；Boundary 自带 digest 语义版本，版本不同不能直接比较。
Codex full Turn 与 Claude Code durable SessionMessage
继续和各自 live adapter 共用归一规则。

Baton 将 Snapshot 的完整持久事实写成归属于同一 HarnessTarget 的普通 turn 与 summary，
语义上等价于 BatonSession 从一开始就存在。adoption 完成后命令只持有一个 `bs_`：
`resume` 打开它，`fork` 调用普通 `forkSession()` 创建 child，不再有第二套 Harness fork 生命周期。

adoption 写入
`meta.adoptedFrom = { session, importedThrough }`，不伪装成 `forkedFrom`：前者记录 Baton
外部 HarnessSession 的不可变来源及已接入边界，后者才是 BatonSession 树中的共享历史边。源
BatonSession 跟随原生会话的 cwd（无法取得时才回退命令 cwd）；无论命令最初接收 `bs_`
还是原生 ID，fork child 都归入发起位置。

接入完成后，BatonSession 是这段逻辑历史的唯一 owner，HarnessSession 是该 Harness 的执行后端。
若用户继续从 Claude Code / Codex 等其它客户端写入同一个原生 Session，Baton 不会自动镜像这些
旁路 turn；但显式再次执行 `baton resume <native-id>` 或 `baton fork <native-id>` 会做一次
只读前缀对账：`importedThrough` 必须仍是新 Snapshot 的前缀，且共享 turn 的消息、工具、
推理、计划、错误与终态等完整语义必须一致，然后才把新增尾部追加到同一个 owner。若前缀
分叉则 fail closed，不猜测合并。直接按 `bs_` 打开不触发 Inspector；需要持续双向同步仍须
引入后台 reconcile，不能让两个 writer 共享一个未对账的会话。

需要严格区分三种执行侧对象：

- `HarnessSession`：Harness 持久拥有、可跨 Baton 进程恢复的会话 identity；
- `HarnessSessionHandle`：Adapter 当前进程内的 opaque 调用句柄，不持久化；
- `HarnessSessionBinding`：当前 BatonSession 到 HarnessSession 的可重建连接，含稳定 identity
  与 adapter-owned resume state。Adapter 在这些信息可知时主动发布，Controller 不轮询，
  更不能把 Handle 当 identity。

因此 `adoptedFrom` 不随当前 Binding 切换而改变。即使某次恢复失败后创建了新的 HarnessSession，
再次使用最初来源 ID 仍会找到同一个 Baton owner，再由边界对账决定能否安全继续，而不会因为
当前 `harnessSessionId` 已变化就创建第二个 owner。

配套引入两个打开期机制：

- **会话锁**：session 目录下的 pid 文件，标记"哪个活进程正持有该会话"。
- **crash recovery**：打开会话时归一化上个进程留下的中断残留。

## 流程

1. `baton resume [source]` / `baton fork [source]` 先解析 source：`bs_` 直接走 Baton store；
   HarnessSession ref 通过 registry 的 Inspector 只读观察，随后 adoption 或复用源 BatonSession。不带 id 时仍默认进
   **session picker**，只选择当前 project 的 BatonSession；显式 native id 才触发外部发现。
   picker 不预先打开任何会话，Enter 选中才 resume / 落盘 fork，Esc 取消，Ctrl+C 退出。
2. HarnessSession 来源在源 cwd 创建 BatonSession，将归一历史写入统一 ledger，并原子记录
   `adoptedFrom.importedThrough` 与当前 Binding；已有同一 `adoptedFrom.session` 的 owner 时
   先校验完整语义前缀并补齐新增尾部，再复用该 owner。adoption 完成后，
   resume / fork 仍走 BatonSession 主路径。
3. 一切打开路径（CLI 启动、TUI `/sessions` 切换、`/new`）收敛到 `session/open.ts` 的 `openBatonSession()`：解析目标 → `acquireLock()` → `recoverInterruptedState()`。
4. 所有 fork child 首次发消息时，`Controller.ensureHarness()` 发现无
   `harnessSessionId` → 开 fresh 原生会话并签发新的 ContextEpoch → 从 revision 0 触发全量
   补课（`buildTargetCatchUpContext`）。输入来自 `bs_` 还是原生 ID 都走这一条路径。

session picker 的可读名称对齐 Codex resume 的思路：`meta.title` 只表示用户显式命名；未命名会话以第一条有意义的用户文本预览作为名称，最后才回退到 cwd。chat-tui 粘贴图片产生的前导本地路径按附件处理，不占用名称。preview 在首次提交时只写一次；旧会话只在发现阶段有界读取日志回填展示，不改写历史数据。旧版本自动生成的 `chat/codex/claude @ cwd` 标题视为兼容占位，不遮住更有辨识度的 preview。

## 关键设计

### 为什么 fork 是复制，而不是父指针引用

`session.jsonl` 承载 BatonSession 完整逻辑历史是既有核心不变量，reduce / summarize / catch-up 全都假设单文件。父指针会让"读历史"处处变成两跳，还引入"父被删/被改写"的悬挂问题。复制让 child 完全自包含。

### 为什么领域对象不做 ID remap，而 Event 重新签发

事件里的 `toolCallId`、部分 `messageId` 本就是 harness 原生 ID（Claude 的 `tool_use_id`、Codex 的 `item.id`），不是 baton 签发的全局 ID；remap 它们没有唯一性收益，反而破坏 payload 与 `raw` 的审计对照。复制前缀既然是同一段逻辑历史，保留原 ID 恰是正确的身份表达；将来跨会话引用 turn 时用 `bs_ + t_` 限定即可消歧。`seq` 同理原样保留——边界永远是前缀（全局串行队列保证），天然连续。

Event envelope 是例外：`eventId` 标识某个 ledger 中的一次 append，`scope` 是该 Event 的唯一
权威归属。fork 写入 child ledger 时必须重新签发 `eventId` 并改成 child session scope；否则
同一个 event id 会同时声称属于两个 ledger。payload 中的 turn / interaction / message /
toolCall 等领域对象 ID 仍原样保留。

### 为什么 harnessSessions 只保留 target 配置，不保留原生 session 绑定

`harnessSessionId` / `resumeState` / `contextEpochId` / `syncedSeq` / `resumeCursor`
描述的是源会话与其原生 HarnessSession 的绑定（`resumeState` 是 adapter-owned 的版本化
checkpoint，`syncedSeq` 只是 Receipt 基线的缓存），child 若继承会 resume 源的原生会话，
导致两个 BatonSession 写进同一份 harness 历史，fork 即失效。`model` / `effort` 是用户偏好，
丢掉会让 child 静默回落 harness 默认值，故单独保留。
`harnessTargetId` / `harness` 也要保留，使 child 仍知道后续应使用哪个配置目标和执行协议；
`HarnessLaunchSnapshot` 与源原生 session 的那次启动绑定，child 会 fresh launch，因此不复制。

### 为什么 recovery 挂在打开入口，且以锁为前提

recovery 的核心价值不是修 UI 状态（TUI 的 busy 来自 controller，不来自 reduce），而是：**catch-up 与 `@` 引用只读 `_baton_turn_summary`，没有 summary 的半截 turn 对后续 harness 同步是永久盲区**。归一化动作与 `controller.finalizeTurn` 的收口顺序一致（终态 → notice → summary）。

前提是持锁："最后事件是 running"只有在没有活进程持有会话时才能断定为崩溃残留，否则合成终态会污染另一个进程正在执行的活会话。锁只服务这个判定，不承担并发追加的完整保护（headless REPL 目前不加锁，属已知豁免）。抢锁用 `O_EXCL` 原子创建（不做"先检查再写入"，那是 TOCTOU）；锁不做进程内引用计数——约定同一进程内一个 session 至多一个活 handle，进程内并发归上层（TUI 单前台会话；将来多 Session Controller 由 session slot 唯一性保证）。

recovery 同时覆盖 fork：源会话若正在运行（或曾崩溃），复制会带进半截 turn；child 首次打开时经同一条归一化路径补上终态与 summary，`forkSession()` 自身不必关心。

### fork 的上下文保真度 = turn-summary 保真度

child 的 harness 通过补课看到的是紧凑 turn 摘要（预算内优先保最近，默认 4KB 字符），不是全量事件回放。这与既有跨 harness 接力的保真度一致，不是 fork 引入的新损耗；但用户直觉可能预期"fork = 完整带走上下文"，故显式记录。完整历史仍在 child 的 `session.jsonl` 里，随时可被更高保真的注入策略消费。

adoption 源在 Harness 内拥有完整持久历史；Baton ledger 逐 turn 记录 Inspector 能从只读接口
恢复的持久语义。Codex full Turn 能恢复 user/assistant、reasoning、工具、计划提案与终态，并与
live adapter 共用 ThreadItem 归一；流式 delta、瞬时运行状态或只存在于通知流而未持久化的数据
不伪造。Claude Code 的 SessionMessage 能恢复 user/assistant、thinking、工具调用与文本结果、
Todo/Task 计划投影和计划提案，并与 live adapter 共用 durable block 归一；只读接口不提供
stream delta、result usage / 终态和消息级私有 `structuredPatch`，因此 Baton 不猜测这些字段，
重建 turn 以 `stopReason: unknown` 明示证据边界，绝不提升成 `end_turn`。resume 源并继续同一 Harness 时，更完整的运行上下文由原生
session 保证；fork child、跨 Harness 接力则复用已进入统一 ledger 的 turn summary。

### 跨 project fork：历史跟源走，project 跟发起位置走

session 按 cwd 归入 project 只是**存放与发现的组织方式**，不是历史的属性；而 fork 的本质是"把一段逻辑历史带到新的工作现场继续"。所以两者各自跟随自己的锚点：

核心场景是跨仓排查：开发 project-a 时，排查过程发现它实际调用的 project-b 存在 bug。用户进入 project-b（包括另一个 monorepo）执行 `baton fork <project-a-session>`，即可把已经形成的调用关系、现象和判断上下文带到 project-b 继续修复，不必重新向 agent 解释问题。这里 project 由 fork 命令的执行 cwd 定义；跨 project 不是额外模式，而是源 session 的 cwd 与发起 cwd 不同所自然产生的结果。

这也是 session 归 Baton 管理、而非委托给 harness 原生 session 的直接收益：部分 harness 不允许原生 fork 跨 project，Baton 则在自身层复制逻辑历史，再到目标 cwd 创建 fresh HarnessSession 并补齐上下文，因此不依赖 harness 的跨 project fork 能力，也不修改其原生 session 文件。BatonSession 是历史真相源，HarnessSession 只是特定工作现场下的执行载体与 resume 加速路径；否则 Baton 的能力会退化成各 harness 原生能力的交集。

- **历史跟源 session 走**：复制的前缀、谱系（`forkedFrom`）都来自源，与源在哪个 project 无关。
- **project 归属跟 fork 发起位置走**：`cd project-b && baton fork bs_from_project_a`，fork 落在 project-b（`--cwd` 可覆盖）；picker fork 用启动 baton 时的 cwd。底层 `forkSession` 未显式指定目标 cwd 时仍沿用源 cwd，保持已有调用兼容。

这天然覆盖同 project fork（发起位置 == 源 project 时退化为原行为），所以不需要 `--to` 之类的显式参数。`resume` 则相反：回到会话原本的 project——resume 是"继续那个现场"，fork 是"带走历史开新现场"。

实现上只需在 fork 时把 `meta.cwd` 与落盘目录
（`projects/<project-key>/sessions/<sid>`）一起换成目标 cwd：controller 执行工具、footer
展示、`listSessions({cwd})` 发现全都以 `meta.cwd` 为真相源，自动跟随；child 本就不 resume
源的原生 HarnessSession（fresh native + 全量补课），换 cwd 不影响上下文重建。注意 project
目录与 `meta.cwd` 必须同源，否则按目录扫描的 `listSessions({cwd})` 会漏掉该会话。

跨 project fork 只迁移会话上下文，不复制代码或工作区状态；源 project 的文件路径出现在历史里时，child 的 harness 需自行判断在新 cwd 下是否仍有效。

Plugin 数据与 Binding 同样不被隐式复制。Resource、Proposal 和 PluginInstance 配置以 BatonSession 为
owner；要继续原 loop 应 resume 原 session。未来若真实场景需要“分叉 loop”，必须由 Plugin
显式定义 clone 语义，不能把可能关联外部副作用的状态目录直接复制给 child。

### 面向 /side 的预留

- `forkSession(sourceSessionId, { throughSeq })`：运行中 fork 只需传入"当前 active turn 之前"的水位，无需新入口。
- 锁按 per-session 设计，一个进程可同时持有多把（多 Session Controller 的前提）。
- 未决前提（多 Session Controller 的入口条件）：主线与草稿共享同一 cwd 的并行写隔离方案（worktree / 只读草稿 / 显式警告）。
