# Baton Plugin

Plugin 让长期领域 loop 在不进入 Baton core 的前提下拥有自己的 Resource、Controller、Connector
和用户入口。本文定义 Plugin 的理念、运行模型和主流程；公共 TypeScript API 与最短示例见
[`packages/plugin/README.md`](../packages/plugin/README.md)，Resource 删除等细节见
[Resource 生命周期](./resource-lifecycle.md)。

## 1. 理念与边界

Baton core 不理解 Requirement、Deployment、Review 等领域语义，只提供生命周期、调度、
持久化、权限、Board、Context 和受控 Output。Plugin 可以封装完整 loop，也可以提供能独立
演进的领域能力或本地自动化。

```text
领域 loop = Resource(spec + status) + level-based reconcile
                                      ▲
             Resource change / Source / Watch / cron / requeueAfter
```

- `spec` 是用户认可的期望与 Contract；
- `status` 是 Controller 重新观察或计算的当前状态；
- signal 只提示“可能变化”，reconcile 每次读取最新事实；
- 智能判断通过 `proposed-input` 交给用户编辑，或通过 `turn-request` 作为非用户发起方请求一个
  受控的新 Turn，不要求先把业务穷举成 DSL。

### 1.1 三种扩展边界

| 边界 | 职责 |
|---|---|
| **Baton Plugin** | 运行在 Harness 之上的控制面，观察和推进跨 Session、跨系统的长期 loop |
| **Harness** | Codex、Claude Code 等智能执行协议，负责推理、工具调用和原生 Session |
| **Harness Plugin** | skill、hook、command 等 Harness 内扩展，约束当前 agent 小闭环 |

devloop 属于 Harness Plugin：它规范开发、lint/test、commit 和 PR/MR，不注册为 Baton Plugin。
reqloop 属于 Baton Plugin/Marketplace：它拥有 Requirement、Deployment、Evaluation 等领域模型
与 Connector。外部系统适配留在 Plugin 内部，不提升为 Baton 的另一种顶层运行角色。

## 2. 共同模型

```text
PluginPackage（不可变交付物）
  └── PluginInstance（用户配置身份）
        └── PluginBinding（当前 BatonSession 的活动绑定）
              ├── Command / ContextProvider
              ├── Controller / Source / Watch
              └── Runner process
```

- **Package** 由 `pluginId + version` 标识，已安装版本不可原地修改；
- **Instance** 由 `plugin@marketplace` 派生稳定 identity，属于一个 BatonSession，保存 enabled、
  版本与配置；
- **Binding** 拥有当前激活产生的注册与清理动作，不保存领域事实；
- **Resource** 以 `apiVersion/kind` 标识类型，以 `namespace/name/uid` 标识具体对象；
- **Board** 是 Resource presentation 的派生读模型，不是另一份状态。

三类事实保持分层：

| 事实来源 | 拥有什么 |
|---|---|
| BatonSession Event Ledger | Baton 输入、执行、Interaction 与感知历史 |
| Plugin Resource `spec/status` | 领域期望、观测与完成条件 |
| 外部系统 | PR、需求、部署等原生事实 |

它们可以通过 reference 和 reconcile 关联，但不能复制成可独立修改的第二真相源。

## 3. Host 与进程边界

```text
Baton host process
  └── Manager
        ├── Instance / Resource / Proposal / Interaction / TurnRequest stores
        ├── keyed reconcile queues / Sources / Watches / Board cache
        └── Supervisor
              └── Runner process × active Binding
                    └── third-party Package + Connector
```

**Manager** 是唯一装配入口，负责恢复 Instance、创建 Binding、安装注册、持久化 Resource/Output、
控制 reconcile 容量和维护 Board cache。

**Supervisor** 只负责 Runner 子进程的启动、deadline、退出和回收，不理解 Resource 或领域策略。

**Runner** 加载一份 Package，保存 Plugin 回调，通过 IPC 执行 activate、Command、ContextProvider、
Source、Watch、reconcile、present 和 cleanup。Runner 不直接访问 Baton Store、Controller、Harness
或 TUI。

隔离粒度选择 Binding，因为它同时是注册撤销、局部连接共享和故障回收的原子边界。同一 Package
在不同 Session 的可变状态不能共享；单次调用起进程又会破坏 Source/Connector 生命周期。
进程隔离是故障和调度边界，不是安全沙箱：Plugin 仍以当前用户身份访问文件、网络和子进程。

IPC 只传可结构化克隆的数据。激活完成后注册表封口，避免异步偷注册留下半个 Binding。调用
timeout、非法信封或进程退出时，Manager 撤销 Binding 的 Command、ContextProvider、Controller、
Source 和 Board，但保留 Resource、Proposal、Interaction 和日志供恢复。当前不自动重启失败
Runner，因为外部副作用可能已经生效却没有回执。

## 4. Resource 与 reconcile 流程

### 4.1 Resource

Plugin Resource 使用版本化类型身份：

```text
apiVersion + kind             类型
namespace + name + uid        对象 incarnation
generation                    spec revision
resourceVersion               opaque 并发 token
owner                         同 Instance 内的结构 owner
labels / annotations          可检索分组 / 宽松扩展 metadata
```

`generation` 只随 spec 变化；Controller 可用 `status.observedGeneration` 表达观测水位。labels
使用精确 AND selector，annotations 不参与检索。两者都不能代替 identity、spec、status、owner
或领域引用。

Resource 删除是 reconcile 生命周期，不是立即移除：Baton 先设置 `deletionTimestamp`，向结构
后代级联删除请求，并在 terminating reconcile 成功后最终移除。完整契约见
[Resource 生命周期](./resource-lifecycle.md)。

### 4.2 统一唤醒

```text
Resource change / startup / Source / Watch / cron / requeueAfter
                             │
                             ▼
                    keyed reconcile queue
                             │ same key coalesces
                             ▼
              reconcile(BatonSnapshot, latest Resource)
                             │
                   ┌─────────┼─────────┐
                   ▼         ▼         ▼
                status    Connector   Output
```

- 同一 Resource key 不并发 reconcile，不同 key 受 Controller 与 Manager 容量限制；
- **Source** 发现外部对象并 emit primary Resource，不 patch status、不产生 Output；
- **Watch** 把已存 secondary Resource 变化映射成 primary reconcile request；
- **cron Source** 固定周期 enqueue 当前 Resource；
- **`requeueAfterMs`** 表示单个 Resource 动态决定的下一次复查；
- 错误进入同一退避队列，reconcile 必须 level-based、幂等、可重放。

外部写入使用稳定 operation key。无法确认是否生效时，先重新观察外部状态再决定重试，不能因
Runner crash 无条件重复副作用。

Baton-owned Resource 是 Event Ledger 的只读派生视图。当前 `baton.dev/v1alpha1, Kind=Turn`
让 Plugin 用同一 level-based 模型观察 Baton 行为；Plugin 不能修改或重新声明 Baton-owned type。

## 5. Output、Board 与 Context

### 5.1 受控 Output

Controller 当前可以返回：

- `proposed-input`：Baton 持久化 Proposal，用户确认、编辑或丢弃；只有提交后才成为普通 Input；
- `interaction`：Baton 持久化问题和答案，再重新 enqueue 原 Resource；
- `turn-request`：Plugin 在直接 user Input 之外请求一个新 Turn；Baton 持久化请求和授权，将其
  物化为 plugin-source Input，再把 Turn 结果交回原 Resource reconcile；
- `requeueAfterMs`：安排下一次 reconcile，不代表副作用授权。

TurnRequest 抽象的是非用户主体创建 Turn 的控制意图，不是 Harness Work。Plugin 不能持有
HarnessAdapter、Harness 进程或 SDK 句柄，也不能直接调用 Harness；Baton 将获批请求物化为受控
Input/Attempt，负责路由、权限、并发、取消、Context 和结果持久化。完整契约见
[TurnRequest](./turn-request.md)。

每个获批请求会获得独立支线 `Lane`；多个支线可受限并发，但不占用会话主 Lane。
Plugin 只从 Snapshot 读取 `laneId` 和结果，不能选择或复用别的 Lane。Lane 是 BatonSession 原生
任务线而非 Plugin 私有对象，后续可以跨 HarnessTarget 接力。

### 5.2 Board

Controller 的 `present(resource)` 把一份 Resource 派生为至多一个 Board 条目。Baton 补齐 owner、
Resource reference 和身份，再生成面向用户的 Board view。`present` 只读、可重复，不能修改
Resource 或外部系统。

Board 是共享协作读模型，但不是 Event、Resource 或外部系统的真相源。当前按 Plugin Instance
和 Resource Type 分组排序，每组只展示有限条目，避免一个 Plugin 占满侧栏。持续状态进入
Resource status/Board；toast 只用于一次操作或状态边沿的短寿命反馈。

### 5.3 Context

ContextProvider 提供用户通过 `@` 明确选择的只读 Context。`search` 无副作用，`provide` 遵守
`maxChars`，不能返回 secret。Binding 关闭时注册整体撤销。

必须区分：

> Board 更新 ≠ Context 已交付 ≠ Harness 已被唤醒。

Plugin presentation 变化只更新读模型；只有用户提交 Input 或获批 TurnRequest 准备执行时，Baton
才组装 Context，并以 DeliveryReceipt 记录 transport 已接受。

## 6. Plugin authoring 约束

Plugin 只能依赖公共类型包：

```ts
import type { PluginPackage, Resource } from "@compforge/baton-plugin";
```

公共包不导出 Manager、Supervisor、Runner、Store、HarnessAdapter 或 Marketplace。作者必须：

1. 让 activate、Command、Context、Source、Watch、reconcile 和 present 等跨边界入口保持 async；
2. 只返回可结构化传输的数据，不返回函数、class instance、stream、socket 或文件句柄；
3. 为 HTTP、DB、Git 和子进程设置 timeout、并发/连接容量、取消与输出上限；
4. 不把 module global 当恢复状态，事实进入 Resource、Event Ledger 或外部系统；
5. Source 和连接响应 abort/onClose，cleanup 能停止订阅和自建进程；
6. 日志使用结构化 `context.logger`，不包含 secret，也不代替 Resource status；
7. 不导入 Baton 私有源码，不解析 Board 展示文本，不直接访问 Harness。

数据目录按 owner 而非 Package version 划分：

| scope | 生命周期与用途 |
|---|---|
| `global` | 当前用户下跨 Project/Session 的 Plugin 数据 |
| `project` | 同 cwd/workspace 跨 Session 的 observation checkpoint 与索引 |
| `session` | 当前 BatonSession 内同 Plugin 共享的数据 |
| `instance` | 当前 PluginInstance 私有执行数据 |

Plugin 只使用 `context.dataDirs`，不自行拼接 `~/.baton`。持久文件带 schema version 并原子替换；
project scope 可能被多 Runner 并发写，需要跨进程锁。Event、Resource、Proposal、Interaction 和
TurnRequest 继续使用宿主 API，不能复制到私有 JSON 形成第二真相源。

## 7. 运行与恢复

启动时，Manager 解析 enabled Instance 和不可变 Package entry，为每个活动 Binding 创建 Runner，
完成 activate 后原子安装注册，再启动 Source、恢复待决 Output/due time 并 initial reconcile。

关闭时先撤销宿主注册，再停止 Source/Runner；Runner 内先 abort Source，再逆序执行 onClose。
禁用、reload 或版本切换不删除持久数据。升级先验证新 Package，关闭旧 Binding 后激活新版本；
失败时恢复旧 Binding。Resource schema migration 由 Plugin 新版本显式完成，Manager 不猜测。

权限采用渐进信任：安装 Plugin 不等于授权 Connector 副作用，时间触发也不会自动扩大权限。
敏感操作必须在具体 operation/scope 上获得可见决议和回执；secret 不进入 Resource、Context、
日志或普通配置文件。

## 8. References

- [`packages/plugin/README.md`](../packages/plugin/README.md) — 公共 API 和最短作者示例
- [Resource 生命周期](./resource-lifecycle.md) — 创建、owner、metadata 与删除状态机
- [Kernel](./kernel.md) — core、Harness 与 Plugin 的顶层边界
- [工作流](./workflow.md) — Input/Interaction 如何进入统一执行路径
- [TurnRequest](./turn-request.md) — Plugin 受控请求一个新 Turn
- [日志体系](./logging.md) — Plugin 结构化诊断
- reqloop 领域设计：<https://github.com/qiankunli/reqloop/blob/main/docs/reqloop.md>
