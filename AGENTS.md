# AGENTS.md

## 项目定位与边界

baton 是一个 terminal-native 的 Loop Engineering 协作内核与控制面，也是跨 coding agent 的统一工作区。
用户始终在自己拥有的 BatonSession 中工作：它保存跨 Harness 的持久逻辑历史，并拥有当前
Session 的交互与 Harness 执行；用户级 Baton Daemon 拥有 Plugin 控制面，Project 按 cwd 组织和
发现 Session，并通过 canonical namespace 共享同一 workspace 的 Plugin Resource。Claude Code、Codex 和 DeepSeek Harness 是当前内置 Harness，
不是封闭支持列表。

baton core 位于人、Harness 和 Baton Plugin 三类参与者之间：

1. **人** 提交目标、编辑工作并给出决议，拥有 BatonSession 的正典协作历史。
2. **Harness** 提供智能执行能力，Adapter 负责协议与事件归一；devloop 等 Harness Plugin 只约束
   Harness 内部的开发小闭环，不成为 Baton Plugin 的私有执行接口。
3. **Baton Plugin** 拥有长期领域 loop，以 Resource 的 `spec/status` 表达期望与观测，由
   Controller reconcile。Plugin 通过 `ReconcileContext.verbs` 请求人的决定、准备 draft 或发起
   Harness Turn，也可用 Hook 观察 Core 协调边界；Harness 只是后续执行端，Plugin 不能绕过 Baton
   直接调用。

Core 只接受 typed intent/verb，并将其物化为 Input、Interaction、HarnessInvocation、Event 等
有身份和状态机的持久对象；它拥有路由、权限、调度、取消、恢复与 Projection，但不提供任意
payload 的 publish/subscribe，也不理解 Requirement、Deployment、Review 等领域语义。

稳定内核已经支持同一 BatonSession 内的 Harness 接力，以及主 Lane 与
异步支线 Lane 并发；Baton Daemon 内的 Plugin Host 已支持 Marketplace、
Command、Resource/Controller、Resource/cron Source 与 `requeueAfter`、Board presentation、
Interaction、reconcile 控制能力、Mention 与 Hook；三方 Package 按 Binding 在独立
Plugin Worker 进程执行；Human Inbox 统一承接 Plugin 发起的人的决策与执行后复核。
同一输入向多 Harness 批量 fan-out 后策展结果，以及跨 BatonSession 的主线 /
草稿收录仍是后续方向，不能用 Plugin 私下持有 Harness 进程或 SDK 句柄来提前实现。

reqloop 是按需安装、可禁用和独立升级的 Marketplace / Plugin 场景；其 Requirement Loop
领域模型与 Connector 始终留在 reqloop，不进入 Baton core。

## 代码地图与核心模块

| 目录 | 职责 |
|---|---|
| `docs/kernel.md`、`docs/workflow.md` | 稳定内核、核心概念、不变量与端到端双向工作流 |
| `docs/harness.md`、`docs/harness/` | Harness 公共抽象，以及 Codex / Claude Code / DeepSeek Harness 原生协议适配 |
| `docs/plugin.md` | Plugin host、authoring 契约与长期领域 loop |
| `docs/view.md` | View Adapter、chat-tui 公共库与 Baton View 边界 |
| `packages/plugin/` | `@compforge/baton-plugin` 公共纯类型契约；三方 Plugin 的唯一宿主依赖 |
| `src/channel/`、`src/controller/`、`src/event/`、`src/session/`、`src/store/` | 双向协调边界、Input/Attempt/Turn 编排、事件账本、Session 生命周期与重放 |
| `src/harness/` | HarnessTarget、Binding、Adapter、capability 与各 Harness wire 适配 |
| `src/plugin/` | Marketplace、Package/Instance/Binding、Plugin Host/Worker、Resource/Controller 与 Board |
| `src/daemon/`、`src/inbox/` | 用户级 Daemon、Session Gateway 与 Human Inbox |
| `src/context/`、`src/interaction/` | 上下文注册/交付与 Session 内统一待决交互 |
| `src/view/` | View/Core Adapter；内置 chat-tui intent、Projection 映射与 ViewOutput publication |
| `src/cli/` | TUI 进程入口与 headless 工具 |
| `tests/` | 内核、Harness 与 Plugin 契约测试 |

改稳定内核或进程模型前先读 `docs/kernel.md` 和 `docs/workflow.md`；接入 Harness 再读
`docs/harness.md` 与对应 `docs/harness/<provider>.md`；改 Plugin host / API 前读
`docs/plugin.md`。

项目使用 Bun；宿主与公共 Plugin 契约同仓分包。验证命令为 `bun run check`
（typecheck + test）。仓库内试用使用 `bun install && bun link`，普通用户通过 npm 安装，
不暴露 Bun 前置条件。

根目录 `VERSION` 是 Baton 产品版本的唯一事实源；每次逻辑改动至少递增一次 patch，同一轮只递增
一次。根 `package.json.version` 只在 npm 发布前通过 `make sync-npm-version` 从 `VERSION` 派生，
不在普通代码改动中手工维护；`packages/plugin/package.json` 仍管理独立 Plugin 包版本。

## 关键约定

1. **作用域决定 owner**：Project 组织同 cwd 的 Session；BatonSession 拥有正典历史与交互/Harness
   执行；Plugin Binding 由 `plugin@marketplace + canonical namespace` 标识，Package 通过
   `v1`、`v1/project`、`v1/project/session` 声明 Worker 基数；HarnessTarget 是配置、调度与状态坐标；
   Lane 是 BatonSession 原生的串行任务线，可跨 HarnessTarget 接力；
   HarnessSession 是 `Lane × HarnessTarget` 下由 Harness 持有的持久执行会话；进程内 Handle 只负责调用路由，
   mutable Binding 只描述当前连接，二者都不能代替 HarnessSession identity。
   Binding、上下文水位和执行投影按 `Lane × HarnessTarget` 隔离，偏好按 Target 共享；未知 ID
   fail closed，不能从 Harness 名、alias 或 wire key 猜实例。
2. **事实与投影分层**：Event 是 Session 内的正典事实，Event Ledger 只负责持久记录与回放；
   BatonSession 直接用同一 reducer 维护 live Projection，消费者不订阅 Ledger。Plugin Resource
   `spec/status` 是领域期望与观测的真相源，外部系统继续拥有自己的事实；TUI 与 Board 都是
   带归属的派生投影。live、resume 和自愈必须走同一 reducer；Board 更新、Context
   已交付与 Harness 已被唤醒是三个独立事实。Resource 以 `apiVersion/kind` 标识类型，以
   `namespace/name/uid` 标识对象；`labels` 是受约束、可检索的分组 metadata，`annotations`
   是宽松、不参与检索的扩展 metadata；调度控制不进入公开 metadata。
3. **Typed coordination 串联三类参与者**：Baton core 保持领域无关；一个 BatonSession lease 同时只有一个
   active `Channel`，由它装配 Session Controller、Interaction 路由和订阅，并统一承接
   ViewInput 与 ViewOutput 的 typed path。Channel 只拥有进程期生命周期，不复制任何可恢复
   状态，也不代替 Queue、Controller、Interaction domain 或 Harness 干活。
   人、Harness 和 Baton Plugin 通过稳定 verb 与 Core-owned 对象协作，而不是向通用 topic 投递 opaque message。Baton Plugin 通过 Resource /
   Controller 与 reconcile 作用域能力推进领域 loop；`ask/confirm` 组织 human-in-the-loop，
   `draft` 交给用户修改，`harness` 请求在主 Lane 或新 Lane 执行。所有发起新动作的 verb 都先持久化为
   Interaction；策略可以自动批准，但不能绕过 gate。通过后才创建 HarnessInvocation，最终 Input
   统一走 Context、Permission、Attempt 与 routing。Plugin verb 属于 Core 签发的 live execution，
   不以 Resource 或 caller key 作为 continuation identity；调用必须带 timeout，并真实 await
   `success/dismissed/timeout/failure`。等待时释放 Controller 与 Manager 并发位，Worker/Core 崩溃
   则以 failure 收口而不重放调用栈。
   Plugin 只能依赖
   `packages/plugin` 公共契约，不能持有宿主 Store、Controller、Harness 进程或 SDK 句柄。
   Marketplace Plugin 按活动 Binding 进入独立 Worker；Plugin Host 按 canonical namespace 管理
   Binding，持有对应 Resource/Controller、reconcile 调度与 Worker 生命周期。Human Inbox 和
   Session Gateway 是 Daemon 内的同级服务。
   `chat-tui` 是 Baton 与 Doctor 可共同使用的公共终端 UI 库；Baton 特有的 ViewInput / ViewOutput
   适配留在 `src/view/chat-tui`，不反向进入 chat-tui。
4. **Harness 差异只留在 Adapter / capability**：新增 Harness 默认只改对应 adapter、registry
   与 identity 目录；Session、store/reduce、Projection 和 chat-tui 不出现 Harness 分支。开放
   wire 值在边界保守归一，原始形态保留在 `raw`；外部 HarnessSession 只经只读 Inspector
   生成 HarnessHistorySnapshot，再 adoption 为 BatonSession；此后 resume / fork 只走
   BatonSession 主路径。adoptedFrom 是不可变 owner 来源，当前 Binding 可重建；显式再次接入
   只允许按 HarnessHistoryBoundary 对账完整语义前缀后补尾，分叉即失败。Baton 不托管 Harness 凭证。
5. **可信交付必须有显式事实**：Controller 拥有 Input、Attempt 与 Turn 生命周期，Interaction
   域统一拥有 Harness/Plugin requester 的待决生命周期，Adapter 拥有 Harness 执行；投递先持久化
   再 dispatch，无法证明结果时保留 `uncertain`；
   Context 只有 DeliveryReceipt 才推进目标 HarnessSession 的 Epoch。审批、用户决议和自动 reviewer
   必须有可见、可恢复的权威回执，未知终态或策略一律悲观处理。

## References

- `docs/kernel.md` — 稳定内核、核心模型与关键不变量
- `docs/workflow.md` — Input、Context、Attempt、Harness Event、Interaction 与用户反馈主流程
- `docs/harness.md` — HarnessTarget、Session、Adapter、Capability 与扩展契约
- `docs/harness/codex.md`、`docs/harness/claude-code.md`、`docs/harness/deepseek-harness.md` — 内置 Harness 的协议适配
- `docs/plugin.md` — Baton Daemon / Plugin Host / Worker、Resource/Controller 与三方 authoring 契约
- `docs/view.md` — View Adapter、chat-tui 集成和新增 View 的接入边界
- `docs/resource-lifecycle.md` — Plugin Resource 准入、结构 owner、删除与恢复契约
- `docs/approval-lifecycle.md` — 审批诚实性、授权方与回执
- `docs/logging.md` — Baton、Harness 与 Plugin 共用的结构化运维日志
- `docs/resume-fork.md`、`docs/session-paths.md` — Session 恢复、fork 与主线 / 草稿语义
- `docs/backlog.md` — 暂缓能力及其启动条件
- reqloop 领域设计：
  `https://github.com/qiankunli/reqloop/blob/main/docs/reqloop.md`
