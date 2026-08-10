# AGENTS.md

## 项目定位与边界

baton 是一个 terminal-native 的 Loop Engineering 控制面，也是跨 coding agent 的统一工作区。
用户始终在自己拥有的 BatonSession 中工作：它保存跨 Harness 的持久逻辑历史，并拥有当前
Session 的 Plugin 数据与执行；Project 按 cwd 组织和发现 Session，也承载同一 workspace
跨 Session 的 Plugin 私有数据。Claude Code 和 Codex 是首批内置 Harness，不是封闭支持列表。

baton 按三层协作：

1. **Baton core** 提供 Input、Interaction、Event、Context、权限、Harness routing、调度和
   Projection 等通用控制能力，不理解 Requirement、Deployment、Review 等领域语义。
2. **Baton Plugin** 拥有长期领域 loop，以 Resource 的 `spec/status` 表达期望与观测，由
   Controller reconcile。Plugin 可通过 Proposal 建议一条可编辑 Input，或通过 TurnRequest 作为
   非用户发起方请求一个受控的新 Turn；Harness 只是后续执行端，Plugin 不能绕过 Baton 直接调用。
3. **Harness** 提供智能执行能力，Adapter 负责协议与事件归一；devloop 等 Harness Plugin 只约束
   Harness 内部的开发小闭环，不成为 Baton Plugin 的私有执行接口。

稳定内核已经支持同一 BatonSession 内的 Harness 接力；Plugin host 已支持 Marketplace、
Command、Resource/Controller、Resource/cron Source 与 `requeueAfter`、Board presentation、Proposal /
Interaction、TurnRequest 和 ContextProvider；三方 Package 按 Binding 在独立 Runner 进程执行。
多 Harness 并行汇总以及主线 / 草稿收录仍是后续方向，不能用 Plugin 私下持有 Harness 进程或
SDK 句柄来提前实现。

reqloop 是按需安装、可禁用和独立升级的 Marketplace / Plugin 场景；其 Requirement Loop
领域模型与 Connector 始终留在 reqloop，不进入 Baton core。

## 代码地图与核心模块

| 目录 | 职责 |
|---|---|
| `docs/kernel.md`、`docs/workflow.md` | 稳定内核、核心概念、不变量与端到端双向工作流 |
| `docs/harness.md`、`docs/harness/` | Harness 公共抽象，以及 Codex / Claude Code 原生协议适配 |
| `docs/plugin.md` | Plugin host、authoring 契约与长期领域 loop |
| `packages/plugin/` | `@compforge/baton-plugin` 公共纯类型契约；三方 Plugin 的唯一宿主依赖 |
| `src/controller/`、`src/event/`、`src/session/`、`src/store/` | Input/Attempt/Turn 编排、事件账本、Session 生命周期与重放 |
| `src/harness/` | HarnessTarget、Binding、Adapter、capability 与各 Harness wire 适配 |
| `src/plugin/` | Marketplace、Package/Instance/Binding、Manager/Supervisor/Runner、Resource/Controller 与 Board |
| `src/context/`、`src/interaction/` | 上下文注册/交付与统一待决交互 |
| `src/tui/`、`src/cli/` | chat-tui 投影装配、交互入口与 headless 工具 |
| `tests/` | 内核、Harness 与 Plugin 契约测试 |

改稳定内核或进程模型前先读 `docs/kernel.md` 和 `docs/workflow.md`；接入 Harness 再读
`docs/harness.md` 与对应 `docs/harness/<provider>.md`；改 Plugin host / API 前读
`docs/plugin.md`。

运行时使用 Bun；宿主与公共 Plugin 契约同仓分包。验证命令为 `bun run check`
（typecheck + test）。仓库内试用使用 `bun install && bun link`，普通用户通过 npm 安装，
不暴露 Bun 前置条件。

根目录 `VERSION` 记录项目内部版本；每次逻辑改动至少递增一次 patch，同一轮只递增一次。
npm 包版本独立管理，不随 `VERSION` 自动更新。

## 关键约定

1. **作用域决定 owner**：Project 组织同 cwd 的 Session，并拥有 workspace 级 Plugin 私有数据；
   BatonSession 拥有正典历史和 session 级 Plugin 数据；HarnessTarget 是配置、调度与状态坐标；
   HarnessSession 是 Target 内由 Harness 持有的持久执行会话；进程内 Handle 只负责调用路由，
   mutable Binding 只描述当前连接，二者都不能代替 HarnessSession identity。
   Binding、授权、偏好、上下文水位与投影状态按明确的 Session / Target 身份隔离，未知 ID
   fail closed，不能从 Harness 名、alias 或 wire key 猜实例。
2. **事实与投影分层**：Event Ledger 是 Session 执行与感知历史的真相源，Plugin Resource
   `spec/status` 是领域期望与观测的真相源，外部系统继续拥有自己的事实；TUI 与 Board 都是
   带归属的派生投影。live、resume 和自愈必须走同一条 append/reduce 路径；Board 更新、Context
   已交付与 Harness 已被唤醒是三个独立事实。Resource 以 `apiVersion/kind` 标识类型，以
   `namespace/name/uid` 标识对象；`labels` 是受约束、可检索的分组 metadata，`annotations`
   是宽松、不参与检索的扩展 metadata；调度控制不进入公开 metadata。
3. **长期 loop 与执行小闭环分层**：Baton core 保持领域无关，Baton Plugin 只通过 Resource /
   Controller 和受控 Output 推进领域 loop；`proposed-input` 经用户确认后成为 user-source Input，
   `turn-request` 是 user Input 之外创建新 Turn 的控制意图，经授权后物化为 plugin-source Input，
   再走 Baton 的 Context、Permission、Attempt 与 Harness routing。它不抽象 Harness Work。
   Plugin 只能依赖
   `packages/plugin` 公共契约，不能持有宿主 Store、Controller、Harness 进程或 SDK 句柄。
   Marketplace Plugin 按活动 Binding 进入独立 Runner；线程 / 进程编排由 Baton 持有，
   chat-tui 只负责终端焦点、输入路由和 surface 投影。
4. **Harness 差异只留在 Adapter / capability**：新增 Harness 默认只改对应 adapter、registry
   与 identity 目录；Session、store/reduce、Projection 和 chat-tui 不出现 Harness 分支。开放
   wire 值在边界保守归一，原始形态保留在 `raw`；外部 HarnessSession 只经只读 Inspector
   生成 HarnessHistorySnapshot，再 adoption 为 BatonSession；此后 resume / fork 只走
   BatonSession 主路径。adoptedFrom 是不可变 owner 来源，当前 Binding 可重建；显式再次接入
   只允许按 HarnessHistoryBoundary 对账完整语义前缀后补尾，分叉即失败。Baton 不托管 Harness 凭证。
5. **可信交付必须有显式事实**：Controller 拥有 Input、Attempt、Turn 与 Interaction 生命周期，
   Adapter 拥有 Harness 执行；投递先持久化再 dispatch，无法证明结果时保留 `uncertain`；
   Context 只有 DeliveryReceipt 才推进目标 HarnessSession 的 Epoch。审批、用户决议和自动 reviewer
   必须有可见、可恢复的权威回执，未知终态或策略一律悲观处理。

## References

- `docs/kernel.md` — 稳定内核、核心模型与关键不变量
- `docs/workflow.md` — Input、Context、Attempt、Harness Event、Interaction 与用户反馈主流程
- `docs/harness.md` — HarnessTarget、Session、Adapter、Capability 与扩展契约
- `docs/harness/codex.md`、`docs/harness/claude-code.md` — 首批内置 Harness 的协议适配
- `docs/plugin.md` — Plugin Manager / Supervisor / Runner、Resource/Controller 与三方 authoring 契约
- `docs/turn-request.md` — 直接 user Input 之外受控创建新 Turn 的语义与 Plugin 契约
- `docs/resource-lifecycle.md` — Plugin Resource 准入、结构 owner、删除与恢复契约
- `docs/approval-lifecycle.md` — 审批诚实性、授权方与回执
- `docs/logging.md` — Baton、Harness 与 Plugin 共用的结构化运维日志
- `docs/resume-fork.md`、`docs/session-paths.md` — Session 恢复、fork 与主线 / 草稿语义
- `docs/backlog.md` — 暂缓能力及其启动条件
- reqloop 领域设计：
  `https://github.com/qiankunli/reqloop/blob/main/docs/reqloop.md`
