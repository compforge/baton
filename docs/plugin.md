# Baton Plugin 设计

> 状态：分阶段实现。Instance 持久化、可信进程内 Package 激活、Binding 生命周期，
> Resource / Controller / Proposal / 持久 Interaction / Board presentation / 动态唤醒 / Controller Resource/cron Source、Baton-owned `Turn` Resource
> 派生与 watch，以及本地 / Git Marketplace 的发现和不可变 Package 安装、用户级
> Plugin 启停、`/plugins` 首期管理面和
> `/reload-plugins`、Plugin Command 与显式 ContextProvider 已经落地；持久 Resource Context
> source、配置编辑 UI 和权限审阅仍按真实产品入口增量
> 实现。
> Loop 控制面的整体位置见
> [Loop Engineering](./loop-engineering.md)，reqloop 的领域设计见
> [reqloop 独立仓文档](https://github.com/qiankunli/reqloop/blob/main/docs/reqloop.md)，
> 当前稳定内核见 [kernel](./kernel.md)。

## 1. 理念与概念

### 1.1 要解决的问题

Baton Plugin 要让一个扩展在不进入 Baton core 的前提下：

1. 通过稳定、只读的 Baton-owned Resource 感知 Baton 内部事实；
2. 需要长期收敛时，定义自己的 Resource，以 `spec` 表达期望、以 `status` 表达观测；
3. 根据最新 Baton-owned / Plugin-owned Resource 和外部状态执行 reconcile；
4. 产生可由人审核的推荐输入，或请求用户对当前 Resource 作出持久决定；
5. 在 Baton 重启后从 Event Ledger、Resource、Proposal 和 Interaction 恢复工作。

Plugin 不是一组随意拼接的回调。它既是可交付的能力包，也是用户级可配置、在各
BatonSession 中拥有独立运行态的领域参与者。Baton 负责控制面一致性，Plugin 负责自己的领域模型和外部系统适配。
Plugin 也不必等于一个 loop：例如“分析刚完成的用户问题并推荐合适 Harness”的 Plugin，只需
观察 Baton-owned `Turn` 并产生 Proposal，不必先创建一份 Resource。

本文不决定 Harness Plugin 如何报告 `DevelopmentOutcome`。无论未来使用 Harness 原生事件、
Hook bridge 还是受控命令，进入 Baton 后都必须先归一成带可信来源的 Event；Baton Plugin 只
依赖归一后的事实，不依赖其 transport。

### 1.2 三层边界

三类扩展位于不同层次：

- **Harness Plugin**：运行在 Codex、Claude Code 等 Harness 内，扩展或约束当前 agent loop；
- **Baton Plugin**：运行在 Harness 之上的控制面，观察和推进跨 session、跨系统的领域 loop；
- **Harness**：执行智能工作的专用协议，不是普通 Baton Plugin 的一种能力。

Baton core 不导入 Requirement、Deployment、Review 等 Plugin 领域类型。Plugin 也不能持有
Controller、HarnessAdapter、EventStore、BoardState 或 TUI 的裸句柄。跨 Plugin 协作统一经过
Baton 的 Resource、Event 和受控输出路径，不直接调用彼此的内部接口。

一个 Plugin 包未来可以附带 Harness 实现，但 Harness 仍按独立的 Harness 契约注册和运行，
不进入普通 Plugin Controller。

### 1.3 运行模型

```text
PluginPackage
    └── PluginInstance
          └── PluginBinding
                ├── Command[]
                └── Controller[]
```

#### PluginPackage

`PluginPackage` 是不可变的交付物，包含：

- 稳定的 `pluginId`、版本和 manifest 版本；
- 展示信息、配置 schema 和 secret 声明；
- 可安装前审阅的能力与权限声明；
- 激活入口及其所需的只读资源。

Package 版本目录只读。同一版本一旦安装便不原地修改；升级产生新的 Package 版本，避免运行中
代码和已审阅权限发生静默漂移。

当前可信进程内实现把运行契约收窄为 `pluginId + version + activate(context)`。Package
manifest 先声明 `manifestVersion + pluginId + version + entry` 和可选展示信息；配置 schema、
能力与权限声明等到对应的安装审阅和运行期校验入口出现时再扩展，不先造无人消费的
字段。

三方 Plugin 只依赖独立的 `@qiankun01/baton-plugin` 类型包。它与 Baton 宿主位于同一
monorepo，便于契约、宿主适配和测试原子演进，但独立版本化和发布；其中只包含
`PluginPackage`、`PluginActivationContext`、Resource/Controller、ContextProvider、
`BatonSnapshot`、`PluginOutput` 和 Interaction 等作者契约。Manager、Binding、Controller、Store、
Marketplace、持久化与 Harness runtime 均留在 Baton 私有实现。Baton 自己也消费这份公共
契约，不维护第二套同名类型。

#### PluginInstance

`PluginInstance` 是一份用户级 Plugin 配置在某个 BatonSession 中的运行时实例，包含：

- 稳定的 `plugin@marketplace` 身份、派生 `pluginInstanceId` 和 Package 版本引用；
- 当前实例所属的 `batonSessionId`；
- 启用状态、配置、secret 绑定和权限策略；
- 当前 Session 内独立的可写数据位置。

首版一个 `plugin@marketplace` 对应一份用户级配置。`pluginId` 回答“是什么扩展”，
`marketplace` 回答“从哪个分发源安装”，二者共同避免不同 Marketplace 的同名 Package
互相覆盖。多账号、多环境实例等到出现真实配置路由需求后再扩展，不复用 marketplace 冒充环境。

用户级配置只保存版本、enabled、config 及后续的 secret/权限引用。Connector cursor、缓存或
确实私有的运行材料仍归当前 BatonSession；可驱动 loop 的领域状态进入 Plugin-owned Resource 的
`spec/status`；外部平台仍是其领域事实的来源。不能把一份不透明的
`private runtime state` 变成 Baton 无法恢复、无法审计的第二真相源。

#### PluginBinding

`PluginBinding` 是 PluginInstance 在当前 Baton 进程中的一次活动绑定。它拥有本次激活产生的
全部 handler、订阅和定时唤醒，并在 disable、reload 或进程退出时统一撤销。

Binding 是临时生命周期，不持久化业务事实。把运行期注册收口到 Binding，可以保证激活失败时
整体回滚，禁用或升级时不会留下旧版本回调。

当前 `PluginActivationContext` 开放按当前 Instance 收口的 `registerController`、
`registerContextProvider`、
session-scoped 的 `toast`、`logger`，以及非 Resource 资源的 `onClose`
cleanup。激活完成后 Binding 被封口，不能异步偷注册新 handler；关闭时按注册逆序撤销；
Plugin 先登记底层 Connector cleanup、再登记依赖它的 handler，即可保证 handler 先停、
Connector 后关。

Toast 是不落 Event Ledger 的短寿命操作回执；Board 是从 Resource 派生、可持续观察的当前状态。
Plugin 可以在显式操作或状态迁移时调用 `context.toast.show()`，但 reconcile 会重复执行，不能在
每次 reconcile 时无条件发 Toast。持续异常、进度和待处理事项应进入 Resource status，再由
Board presentation；首次进入异常等边沿变化可以额外发一次 Toast 提醒。

`context.logger.write()` 是 session-scoped 的旁路诊断入口。Plugin 只提交 level、局部
component、message、error 和 JSON primitive details；Baton 自动补齐 PluginPackage /
PluginInstance 身份，并写入当前 BatonSession 的 `session.log`。Plugin 不知道日志路径，也不能
把日志当成 Resource 状态或 Event。日志不得包含 secret；周期 reconcile 对重复异常应按路径、
错误指纹或状态迁移去重，避免诊断日志反过来成为噪声源。

#### Resource

Plugin 用类似 CRD 的方式声明领域 Resource schema；Baton 持久化通用信封，但不理解
`spec/status` 内部字段：

```text
Resource<TSpec, TStatus>
├── apiVersion    versioned schema group
├── kind          schema kind
├── metadata
│   ├── name / namespace / uid
│   ├── generation / resourceVersion / creationTimestamp
│   └── labels? / annotations?
├── spec          用户认可的期望状态与 Loop Contract
└── status        Controller 观测到的当前状态、条件和结果引用
```

身份分成两层：`apiVersion + kind` 标识类型，`namespace + name` 标识当前对象，`uid` 标识这次
具体创建。Plugin Resource 的 namespace 是 `pluginInstanceId`；Baton-owned Resource 使用保留的
`baton-system` namespace。只按 name 解析的引用会跟随同名重建对象；需要证明“仍是原对象”时
使用带 uid 的 `ResourceRef`：

```ts
interface ResourceRef {
  apiVersion: string;
  kind: string;
  namespace: string;
  name: string;
  uid?: string;
}
```

`labels` 用于第三方 Plugin 附加机器可读的分类信息，`annotations` 用于不参与身份的扩展信息；
两者都是 string map，可在创建 Resource 时提供。它们不构成 Resource 身份，也不替代
`spec/status` 的领域事实。领域间的权威关系仍应把 `ResourceRef` 放入自己的 `spec/status`。
这与 Kubernetes 的分层一致：Deployment 用 `spec.selector` 和 Pod template labels 表达集合
关系，Deployment → ReplicaSet → Pod 的实际归属链则由各级 `ownerReferences` 表达；通用信封
负责身份，领域 schema 负责关系。Baton 当前只提供引用形状，不在本轮引入 owner-reference
GC、finalizer、label selector 或通用关系索引。

`spec` 与 `status` 的区分是 Loop 的声明性边界：

- `spec` 回答“希望这条 loop 最终怎样”，由用户直接编辑，或接受 Harness / Plugin 的建议后更新；
- `status` 回答“现在实际怎样”，由 Controller 根据 Baton、Harness 和外部系统事实更新；
- `metadata.generation` 随 `spec` 变化递增，`status.observedGeneration` 表示当前状态基于哪版
  Contract；
- Plugin 可让自己的 status 扩展 `ConditionedStatus`，按需提供 Kubernetes 风格的
  `conditions?: ResourceCondition[]`；Baton 只保存统一 wire shape，不解释 condition type
  或领域策略；
- `metadata.resourceVersion` 是不应被解析的乐观并发 token；status 变化会更新它，调度变化不会；
- `nextReconcileAt` 是 Baton 恢复 workqueue 的内部 control，不属于 Plugin 可见 metadata；
- `status` 原则上应能重新观测或重新计算，不能藏入唯一凭据或不可恢复的工作；
- Board 是 Resource 和其他协作事实的人类可读展示与操作面，不是 Resource 本身或另一份真相源。

用户、Harness 和外部系统都可以带来新事实，但不直接任意改写同一份对象：用户认可的决定进入
`spec`，Harness 与外部系统的产出作为带 provenance 的 observation 进入，Controller 统一收敛
`status`。未来一个 Loop 启动多个 Harness 时，各自产出仍汇入同一个 Resource / Board，不形成
多个并列状态机。

一个 Controller 管理一个 `resourceType`（`apiVersion + kind`），同一 BatonSession 内可以同时
存在多份该类型的
Resource；例如 reqloop 可以同时维护多个仍存活的 `ReqLoopRun`。Baton 不为 Resource 定义
通用 `phase` 或 `metadata.lifecycle`：业务阶段属于 Plugin 自己的 `status`，是否出现在 Board
则由 Controller 的 `present(resource)` 决定。

`ResourceCondition` 对齐 Kubernetes 的字段语义：

```ts
interface ResourceCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  observedGeneration: number;
  lastTransitionTime: string;
  reason: string;
  message: string;
}
```

同一 `type` 最多保留一条当前 condition；`lastTransitionTime` 只在该 condition 的
`status` 发生变化时更新，reason、message 或 observedGeneration 的刷新不算状态迁移。
Conditions 是当前谓词集合，不是事件历史，也不替代 Plugin 自己的 phase 或状态机。
`observedGeneration` 只回答 condition 基于哪版 spec，外部系统观测的新旧仍应由领域 status
中的 `observedAt`、外部 revision 等字段表达。

#### Baton 注册的 Resource kind

Baton 也会把内部事实注册成普通 Resource kind，供 Plugin 只读观察。它们不是另一份持久真相，
也不允许用户或 Plugin 修改：

```text
Session Event Ledger                     Plugin runtime
        │
        └── project ──▶ Resource snapshot ──▶ keyed reconcile
              replay + live             read-only
```

Event envelope 与 payload 继续保持稳定并作为唯一事实来源；Plugin Manager 在消费 Event 时，
按领域语义转换成 level-based snapshot。Plugin 收到 wake 后只拿资源 key，执行时重新读取最新
snapshot，因此 replay、live event 和重复通知都走同一个队列语义。

首个类型是 `baton.dev/v1alpha1, Kind=Turn`：每条 `_baton_turn_summary` 转换成一份以
`turnId` 为 name 的只读对象，`metadata.resourceVersion` 取产生该 Resource 的 ledger `seq`
（对 Plugin 暴露为字符串），status 包含
`TurnSummary` 与 Harness 执行坐标。Plugin 不能 patch 它；如果需要保存自己的期望或观测，
再创建 Resource。

```ts
activate(context) {
  context.registerController({
    resourceType: BATON_TURN_RESOURCE_TYPE,
    async reconcile(baton, resource) {
      return {
        output: {
          kind: "proposed-input",
          text: `Suggested next input for: ${resource.status.userText}`,
        },
      };
    },
  });
}
```

这与 Kubernetes 的关键区别是：Kubernetes controller 通常 watch 内置 Pod 和自己的 CR，
因为 Pod 是实际干活的核心对象；Baton 的内部事实已经存在于 Event Ledger，所以不要求为了
Plugin 再定义一套可写 API 对象。Baton-owned Resource 只是稳定 Plugin API 上的只读视图。

#### ResourceClient API 设计

`ResourceClient` 提供 Plugin 操作自己 Resource 的接口，设计时参考了 Kubernetes
controller-runtime，但根据 Baton Plugin 的实际场景做了调整。

**核心方法**：

```typescript
interface ResourceClient {
  // 读取操作
  get<TSpec, TStatus>(type: ResourceType, name: string): Resource<TSpec, TStatus>;
  list<TSpec, TStatus>(type: ResourceType): Resource<TSpec, TStatus>[];
  
  // 创建资源（spec 固定，status 初始化为空对象）
  create<TSpec, TStatus>(type: ResourceType, init: {
    name: string;
    labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>;
    spec: TSpec;
  }): Resource<TSpec, TStatus>;
  
  // 删除资源
  delete(type: ResourceType, name: string): void;
  
  // 更新状态（唯一的状态更新方式）
  patchStatus<TSpec, TStatus>(
    resource: Resource<TSpec, TStatus>,
    patch: Partial<TStatus>
  ): Resource<TSpec, TStatus>;
}
```

**与 Kubernetes 的差异**：

在 Kubernetes 中：
- 用户/管理员修改 `spec`，表达期望状态
- Controller 读取 `spec` 并更新 `status`，报告观测状态
- `client.Update()` 修改 spec，`client.Status().Update()` 修改 status
- 严格的权限分离（通过 RBAC）

在 Baton Plugin 中：
- Plugin 既是 Resource 的创建者，也是唯一的管理者
- 没有外部用户来修改 spec
- spec 通常是 Plugin 的内部配置（如 `enabled: boolean`），相对稳定
- status 是 Plugin 的运行时状态，频繁更新

**为什么没有 `update()` / `replaceSpec()` 方法**：

1. **避免无限循环风险**：如果允许在 reconcile 中修改 spec，会导致 `generation++` → 触发新的 
   reconcile → 可能再次修改 spec → 无限循环。
   
2. **语义清晰**：Plugin 的 spec 应该在创建时确定，之后只通过 `patchStatus()` 更新运行时状态。
   如果真的需要改变配置，应该删除旧 Resource 并创建新的。

3. **对齐最佳实践**：即使在 Kubernetes 中，controller 也不应该修改自己管理的 CR 的 spec。

**推荐使用模式**：

```typescript
// 1. 创建资源（spec 固定）
const COUNTER_STATE = {
  apiVersion: 'example.baton.dev/v1alpha1',
  kind: 'CounterState',
} as const;

const resource = context.resources.create(COUNTER_STATE, {
  name: 'main',
  labels: { 'example.com/component': 'counter' },
  annotations: { 'example.com/display-name': 'Main counter' },
  spec: { enabled: true }
});

// 2. 初始化 status（首次）
let counter = await context.resources.patchStatus(resource, {
  count: 0,
  observedGeneration: resource.metadata.generation
});

// 3. 后续更新（只更新 status）
counter = await context.resources.patchStatus(counter, {
  count: counter.status.count + 1,
  lastUpdated: new Date().toISOString()
});
```

**metadata 字段的语义**：

- `generation`：spec 变化时递增，由于不允许修改 spec，在 create 后保持为 1
- `resourceVersion`：spec 或 status 修改时更换的 opaque string，用于乐观锁
- `name/namespace`：类型作用域内的查找身份；删除重建仍可复用
- `uid`：具体对象实例的不可复用身份，删除重建后必须变化
- `creationTimestamp`：当前 uid 对应对象的创建时间
- `labels`：可选的机器可读分类 string map，不参与身份
- `annotations`：可选的第三方扩展 string map，不参与身份
- `observedGeneration`：status 中记录，表示当前状态基于哪个版本的 spec

这个设计简化了 API，明确了 spec（配置）与 status（状态）的边界，避免了常见的误用模式。

#### Command 与 Controller

Plugin runtime 的主模型由四个职责不同的对象组成：

```text
Source ── discover / wake ──▶ Resource ── keyed reconcile ──▶ Controller
                                  ▲                              │
                                  └──── status / schedule ───────┘

Manager：装配并运行整条链路
```

- **Resource 是数据与事实边界**：保存身份、`spec/status` 和持久化状态，不承载发现、调度或
  reconcile 行为。
- **Source 是输入边界**：发现并贡献缺失 Resource，把外部变化转换成 wake；不更新 status，
  也不产生 Plugin Output。
- **Controller 是收敛边界**：按稳定 key 读取最新 Resource，通过 reconcile 更新 status、
  安排后续检查，并产生由 Baton 接管的 Plugin Output。
- **Manager 是运行编排边界**：负责注册、启动顺序、队列、容量、定时器、错误和关闭，不承载
  Plugin 的领域判断。

Plugin 的扩展点收束为少量明确能力：

| API | 作用 | 返回或产生 |
|---|---|---|
| `registerCommand` | 用户直接发起的入口 | 创建、选择或修改 Resource |
| `registerContextProvider` | 用户在输入中显式选择的只读上下文 | 按 kind 分组的搜索候选与当前 turn context |
| `registerController` | 控制自有 kind，或观察 Baton 已注册的只读 kind | reconcile、Resource/cron Sources、Board presentation、Plugin Output |

ContextProvider 是显式、单 turn 的上下文入口。Baton 内置和 Plugin 使用相同注册方法：内置
Provider 保持 `session` 这类单词 kind；Plugin Binding 把局部 kind 自动限定为
`<pluginName>@<kind>`，例如 `reqloop@requirement`。Registry 按最终 kind 保证唯一、分组搜索，
并在 Binding 关闭时只撤销该 Plugin 的注册。搜索只读取本地状态；用户选择并提交后才调用
`provide`，返回文本受统一预算约束且不能产生外部副作用。它暂不创建持久 ContextSource /
Receipt；需要追踪可靠投递或跨 turn 水位时再进入 Context delivery。

未来 manifest 可以保存可序列化的能力声明，Binding 再注册对应的运行期 Command / Controller。
Baton 在激活时校验二者一致，既能让安装者提前看见能力和风险，又不把函数或进程细节写进
manifest。

Reconcile 是 Controller 的处理语义，不意味着 Plugin 必须拥有可写 Resource。观察 Baton kind
与领域收敛都使用 `registerController`；一次性动态重查使用 `requeueAfter`，固定周期 resync
和外部对象发现使用两类 Controller Source。无法表达成 desired state 的独立命令出现后再增加
Action，不恢复平行的 Monitor 状态机。

`Source` 使用
`type: "resource" + sourceId + start(context)`。`start` 先完成初始发现并安装文件监听、webhook
channel 等实时订阅，再返回 ready；期间及后续通过 `context.emit(resource)` 贡献该 Controller
管理的 Resource。Baton 统一 materialize 缺失对象并按稳定 key 入队；重复的相同值是幂等
wake，试图隐式改变既有 spec 则报 Source failure。Source 只属于当前 Binding，关闭时
`context.signal` 被 abort。resource Source 不能挂到 Baton-owned 只读 kind。

`CronSource` 使用 `type: "cron" + sourceId + cron + timeZone`，只负责周期性枚举并唤醒
该 Controller 的当前 Resource。Source 不修改 status、不产生 Plugin Output，也不把 signal
写成领域 Event，具体状态仍由逐 Resource 的 `reconcile` 收敛。重启后 cron 从当前时间的
下一次 occurrence 继续，不补放历史 tick；关闭 TUI 后仍需准时运行时再引入 daemon。

Controller 可以附带 `present(resource)`，把每份 Resource 派生为至多一个通用 Board 条目：

```ts
context.registerController({
  resourceType: {
    apiVersion: "reqloop.baton.dev/v1alpha1",
    kind: "ReqLoopRun",
  },
  reconcile,
  present(resource) {
    if (resource.status.phase === "closed") return undefined;
    return {
      title: resource.spec.title,
      status: resource.status.phase,
    };
  },
});
```

Baton 统一补齐 PluginInstance、Resource reference 和最终条目身份；`present` 不写盘、不接收
BoardState，也不能成为第二份业务真相。返回 `undefined` 的 Resource 不显示；没有有效条目时
Board 在 UI 中完全隐藏。单个 Resource presentation 失败会显示归属明确的诊断条目，不遮掉其它
Plugin 的 Board。

### 1.4 Marketplace 与 `/plugins`

`/plugins` 是 Baton 自有、不可被 Plugin 覆盖的统一管理入口。它同时承载 Package 获取和
Instance 管理，但在信息结构上保持两者分层：

```text
/plugins
├── Discover       Marketplace 中可获得的 PluginPackage
├── Installed      已安装的 PluginPackage
├── Marketplaces   已注册的 Marketplace 与来源
└── Errors         Marketplace / Package 加载错误
```

首期管理面保留上方当前 BatonSession 历史，在底部打开可搜索的管理面板；Package 与
Marketplace 详情在面板内逐层展开，不把 Plugin 管理伪装成新的 Session。当前已打通：

- 注册本地目录或 Git 仓库形式的 Marketplace；
- 从 Marketplace 仓内相对路径发现 PluginPackage；
- 校验 Marketplace 索引与 Package manifest 的 `pluginId` 一致；
- 按 `plugin@marketplace + version` 安装不可变快照并记录来源；
- 从 `/plugins` 浏览、搜索、查看详情并安装 Package；
- 在 Package 详情下创建、启用或停用用户级 Plugin 配置，并立即同步当前 Session；
- 从安装缓存加载可信的进程内 PluginPackage，交给现有 Manager 激活。

`baton plugins marketplace add|list`、`baton plugins available`、`baton plugins install` 和
`baton plugins list` 继续作为添加来源与开发验证入口；普通浏览和安装走 `/plugins`。Plugin
自己的 `/requirements` 等 command 用来使用领域能力，`/plugins` 只负责能力的获取、配置和
生命周期。这些管理操作由 Baton core 执行，不注册成普通 Plugin Command / Controller，也不能被 Plugin
自己拦截或替换。

安装入口采用 Claude/Codex 都容易理解的默认：安装成功即在用户级配置中启用；用户也可从
详情中显式禁用。激活失败时回滚为 disabled，避免留下“配置显示启用、当前运行期却未激活”的
半状态。启停对新 Session 自动生效；其它已经运行的 Baton 进程不会被跨进程强行热改。

`/reload-plugins` 只重载当前 BatonSession：先关闭现有 Binding，再重新读取
`~/.baton/plugin.yaml` 与 Package，并激活全部 enabled Plugin。它不改变 enabled 配置；单个插件失败不会阻断其他
插件，最终统一显示成功与失败摘要。Bun 会缓存同一路径的 ESM 及其相对依赖，因此 fresh load
使用独立的临时 Package 快照提供新的模块身份；快照保留到 Baton 退出，避免 Plugin 在激活后
通过模块目录读取资源时路径失效。

Marketplace 是长期的 Package 发现与分发层，负责搜索、版本、来源、信任信息、安装、升级和
卸载。它交付不可变的 PluginPackage 后便退出运行链路，不拥有 Plugin 配置、Binding、
权限策略、Resource 或 reconcile due time。用户入口会在安装成功后另行写入全局
enabled 配置；这仍不等于批准其 Connector 权限。

用户可操作的 Plugin 身份是 `plugin@marketplace`；`pluginId` 仍应使用 owner namespace，
Marketplace 仍记录安装 provenance。同一个 `pluginId + version` 来自不同 Marketplace 时，
安装目录、启用配置和 Package load cache 均隔离，不能因路径相同而互相覆盖。

用户级配置集中在 `~/.baton/plugin.yaml`，最小可手写形状如下；缺省 `config` 也会按空对象
处理，Baton 写回时可以附加时间戳元数据：

```yaml
version: 1
plugins:
  "qiankun/requirement-loop@reqloop":
    enabled: true
    version: 0.1.0
    config: {}
```

Marketplace 和 Package 各自使用一份小 manifest。Marketplace 索引只保存 Package 身份和仓内
相对路径，Package manifest 才是版本、入口和展示信息的权威来源：

```json
{
  "name": "reqloop",
  "plugins": [
    {
      "pluginId": "qiankun/requirement-loop",
      "source": "./requirement-loop"
    }
  ]
}
```

以上文件位于 `<marketplace>/.baton-plugin/marketplace.json`。对应 Package 的
`<package>/.baton-plugin/plugin.json`：

```json
{
  "manifestVersion": 1,
  "pluginId": "qiankun/requirement-loop",
  "version": "0.1.0",
  "entry": "./src/index.ts",
  "displayName": "Requirement Loop"
}
```

`source` 和 `entry` 都不能逃逸各自根目录。`entry` 模块 default export `PluginPackage`，其运行期
`pluginId + version` 必须再次与 manifest 一致。Git Marketplace 在注册时解析并记录 commit，
安装时复制 Package 自包含内容但排除 `.git` 与 `node_modules`；当前不执行依赖安装，因此
Package 入口必须能从安装快照直接加载。

## 2. 流程

### 2.1 安装与激活

```text
discover / install PluginPackage
  → inspect manifest and requested permissions
  → create or update PluginInstance
  → validate config and secret bindings
  → activate PluginBinding
  → register declared Command / Controller
  → replay Baton-registered Resource / restore Plugin Resource / resume due reconcile
```

激活采用 all-or-nothing：任一必要 Command / Controller 注册失败，当前 Binding 整体关闭，不留下部分
可用状态。首期不做运行中无感热升级；更新 Package 后通过 `/reload-plugins` 或下一次启动重新
绑定，优先保证单机多进程场景下的身份和恢复语义清晰。

`MarketplaceRegistry.load()` 从安装目录加载并复核 Package 身份；`Manager` 从用户级
`plugin.yaml` 读取启用配置，以精确
`pluginId + marketplace + packageVersion` 找到 Package，再为当前 Session 创建 Binding。Package 不接收 Store、Controller
或可伪造的 owner；`registerController` 由 Binding 自动补齐
BatonSession 和 PluginInstance scope。单个 Instance 激活失败只关闭并报告该 Binding，不阻断其他 Plugin 的恢复；Manager
退出或 Instance 解绑时，Binding 统一撤销注册和动态唤醒。

Resource type 使用 BatonSession 内的所有权注册表。Baton 启动时先注册
`baton.dev/v1alpha1, Kind=Turn`；Plugin 随后可以为这些类型挂 Controller，但不能重新声明或
通过 `ResourceClient` 创建、删除、修改它们。Plugin 第一次声明其它
`apiVersion + kind` 时取得所有权，同一 Plugin 的多个 Instance 可以复用；不同 Plugin
再声明同一类型会激活失败。这样无需公开一套平行的 Resource 类型，也不会
让第三方覆盖 Baton 的 Resource。

### 2.2 Resource 与 Controller

Baton-owned Resource 更新、Plugin Resource 创建或有效的 `status` 更新、后续 `spec` 更新、启动恢复、
Controller Resource/cron Source 或动态计时到期都只表示
“某个对象可能需要重新检查”。Baton 将同一对象的重复触发合并成 reconcile key：

```text
batonSessionId + pluginInstanceId + apiVersion + kind + name
```

类型所有权在 Controller 激活前已确定；Plugin 只声明 `resourceType`，其余 scope 由 Binding
补齐。

Controller 不把触发原因当成一条必须执行一次的命令。它根据 key 重新读取 Resource 和必要的
外部状态，比较 `spec` 与 `status`，执行当前仍需要的收敛动作：

```text
Baton-owned Resource update / Resource change / startup / schedule or timer due
                         │
                         ▼
enqueue(pluginInstanceId, apiVersion, kind, name)
                         │ same key coalesces
                         ▼
reconcile(BatonSnapshot, latest Resource)
                         │
                         ├── patch status through Instance ResourceClient
                         ├── call owned Connector when authorized
                         └── return { output?, requeueAfterMs? }
```

`Manager` 按 `batonSessionId + pluginInstanceId + apiVersion + kind` 注册和路由
`Controller`。参考
controller-runtime 的分工，每个 Controller 拥有独立 workqueue，隔离重复 key、dirty
follow-up 和局部并发；Manager 统一持有一个动态唤醒队列、错误退避和 Baton 级总容量，避免
Plugin 数量增长时 timer 与执行并发随 Resource 数量线性放大。注册关闭后，该 Scope 的 pending
任务和动态唤醒一并撤销，不会误投到其他 Plugin。

Controller 另外持有同 Resource 的跨进程 reconcile 锁，保证本机多个 Baton 进程不会
同时执行它。该锁不阻塞用户更新 `spec`：Controller 在写回 status 和 due time 时检查
`resourceVersion`，基于旧 Contract 的结果会冲突失败，再由最新 Resource 触发下一轮
reconcile。Baton-owned Resource 来自当前 Session 的不可变 Event Ledger，不提供 status patch；
启动时重放已有 snapshot，运行中订阅同一 `SessionHandle` 的 live append。

首期接口保持窄小。`BatonSnapshot` 是每次执行前冻结的 BatonSession 当前态，
`Resource` 是触发 key 对应的最新 level-based 对象。Plugin 自有 Resource 使用
`Controller<TSpec, TStatus>`；Baton-owned Resource 保持只读，但沿用相同的 reconcile 调用语义：

```ts
interface Controller<TSpec, TStatus> {
  resourceType: ResourceType;
  sources?: ControllerSource<TSpec>[];
  maxConcurrency?: number;
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): Promise<ReconcileResult | void>;
  present?(
    resource: Readonly<Resource<TSpec, TStatus>>,
  ): BoardPresentation | undefined;
}

type PluginOutput =
  | {
      kind: "proposed-input";
      text: string;
    }
  | {
      kind: "interaction";
      decisionKey: string;
      title: string;
      prompt: string;
      options?: Array<{
        optionId: string;
        label: string;
        description?: string;
        role?: "default" | "reject";
      }>;
      allowOther?: boolean;
    };

type ReconcileResult = {
  output?: PluginOutput;
  requeueAfterMs?: number;
};
```

Plugin 自有 Resource 的读写通过 `PluginActivationContext.resources` 提供的 Instance-scoped
`ResourceClient` 完成，类似 controller-runtime Controller 持有的 Client；
`BatonSnapshot` 始终只读，不混入 mutation capability。Baton-owned Resource 不接受 status patch。

`PluginOutput.kind` 是 Baton 定义的封闭联合，每个 kind 对应明确的校验、权限、持久化和 UI
生命周期。`proposed-input` 只是准备交给 Harness 的文本建议，不创建 Baton 内核
Interaction 或另一套审批状态机。Baton 把持久 Proposal 投影为 InteractionDock 中的非阻塞
suggested input；用户显式采用后才进入 composer，可编辑后提交，也可直接丢弃。只有提交后，
它才成为普通 Input，继续走现有 Input → Attempt → Harness 路径。Baton 从本次 Resource 自动取得 resource
identity 与水位，再结合文本摘要给 Proposal 生成稳定内部身份；Resource Proposal 使用
`basedOnGeneration + basedOnResourceVersion`，因此同一 Contract 下的不同外部 observation
可以各自产生一次建议；Baton-owned Resource Proposal 使用 `basedOnRevision`。这些 Manager 管理的
信息不由 Plugin 回填，旧版只有 `basedOnGeneration` 的持久 Proposal 继续按原身份读取。

`interaction` 用于“PR/MR 关联哪个 Requirement”“是否关闭 Requirement”等必须由用户决定、
且回答仍归原 Resource 消费的阻塞协作。`decisionKey` 在该 Resource 内稳定；选项用稳定
`optionId` 表达领域值，`role: "reject"` 只提示展示语义，Plugin 不依赖选项位置。Baton 将问题
写入 Event Ledger 后才展示；用户回答同样先持久化，再重新 enqueue 原 Resource。下一次
reconcile 从只包含当前 Resource 决议的 `BatonSnapshot.pluginInteractions` 读取结果，不注册
选项 callback，也不在内存 Promise 中保存 continuation。无选项时是自由文本，有选项时是单选；
`allowOther` 可额外接受用户输入值。

Manager 在通知 UI 前先持久化 Proposal，接收方按 `proposalId` 幂等投影。`resolution` 缺省即
待处理，首次 `submitted | dismissed` 终结后不再改变；因此同一状态下被丢弃或提交的建议不会
反复出现。进程重启时，Manager 重新投影尚无 resolution 的 Proposal。首期 Controller 不主动
启动、恢复或选择 Harness。

从边界上看，Controller 产出的是受 Baton 接管的 **Plugin Output**，不是直接执行宿主动作。
当前 Output kind 是 `proposed-input` 和 `interaction`：前者持久化成 Proposal，后者进入统一
Interaction opened/resolved 生命周期。未来若增加
`requestHarnessWork`，也必须先转成 Baton 的 Intent / Attempt，经过路由、权限、并发、上下文
交付和回执链路；Plugin 永远不直接取得或调用 `HarnessAdapter`。

`requeueAfter` 是这个 Resource 的一次性动态定时唤醒。对 Resource，Baton 将它换算成内部
control 中持久化的 `nextReconcileAt`，不写入公开 metadata；Manager 只保留一个进程内 timer，
总是唤醒当前最早到期的一批 key。进程
重启后，已到期的 Resource 立即入队，未到期的恢复到动态唤醒队列。空返回会清除旧的 due time，
表示等待 Resource、Input 或 Harness 事实发生变化，不需要独立 Monitor。错误通过抛出表达，
Manager 使用按 key 的指数退避并把下一次 retry 同样写入内部 `nextReconcileAt`，因此 retry 不因进程
退出而丢失；一次成功 reconcile 会重置该 key 的失败计数。Baton-owned Resource 本身只读，due
time 不反写 Resource；进程内仍使用相同 due queue，重启后由 ledger 全量重放再次入队。不引入语义
模糊的 `requeue: boolean`。

Controller 的 resource Source 负责初始发现和实时事件到目标 Resource key 的映射；初始
Source ready 后，Baton 才对该 Controller 的当前对象执行 initial reconcile。cron Source
表达与单次 reconcile 结果无关的固定周期职责，例如每五分钟检查活跃 PR 状态；Baton 使用显式
IANA `timeZone` 计算 occurrence，并枚举该 Controller 的当前 Resource。两类 Source 与
`requeueAfter` 相互独立：前两者属于 Controller 生命周期，后者由某个 Resource 的本次
reconcile 动态决定。

Controller 可以调用 Plugin 自己的 Connector、文件或脚本修改外部系统，因为副作用本来就是“使实际状态
靠近 spec”的一部分，而不是返回值的一部分。前提是当前 `spec` 或已记录的用户决定已经授权该
变化，且 manifest 声明了对应权限。可能已生效却拿不到回执的操作必须使用稳定 operation key，
重试前重新观察外部状态，不能因一次超时盲目重复执行。

### 2.3 后续触发条件

- 无法自然表达成 desired state、又需要被独立调用的命令出现后，再增加 Action，并复用
  Intent / Attempt / Receipt；
- 需要关闭 TUI 后继续实时推进时，再引入 daemon，复用同一 Resource store 和 reconcile queue。

### 2.4 Command 与配置路由

Command 的产品身份属于 Package，以 `pluginId + commandId` 唯一。首版每个
`plugin@marketplace` 只有一份用户级配置：没有可用配置时进入安装或启用引导，有配置时直接
路由。未来若真实场景需要同一 Plugin 的多账号或多环境实例，再为配置增加独立身份与选择入口，
但命令列表仍不生成多份 `/requirements`。

命令一旦开始执行，后续 Resource、Event 和 Board 条目都携带明确的
`pluginInstanceId`，不能依赖“当前 Plugin”之类的隐式全局状态。

Command 返回的 Picker 可以声明本地过滤或远端搜索。本地模式只过滤当前 options；远端模式把
查询词通过同一个 Command 的 `searchQuery` 再次路由到原 PluginInstance。Baton 负责防抖并丢弃
被更新查询取代的响应，Plugin 负责调用领域 Connector 并返回新的 Picker 快照；查询词是短寿命
用户 intent，不写 Resource。远端搜索允许空 options，以便保留搜索框和“无匹配”状态。

### 2.5 Disable、崩溃与升级

全局禁用 Plugin 时，当前操作所在的 Baton 关闭其 Binding，撤销运行期注册和 due timer，并
停止推进 reconcile queue；其它已运行进程在显式 `/reload-plugins` 后同步。已经持久化的
Resource、Receipt 和审计历史继续保留。

新 Session 或进程重启后，Baton 从用户级启用配置重建当前 Session 的 Binding，先恢复待处理
Proposal 和 Plugin Interaction，再扫描 Resource 和内部 schedule，将未完成对象重新 enqueue。
Plugin 发起的待决 Interaction 不会像失去 Harness resolver 的交互那样在 crash recovery 中自动
取消；其 continuation 是持久 Resource key。Package 升级不会
静默覆盖 Session 运行数据；
确需 Resource schema migration 时由新版本显式声明并产生可审计结果。

## 3. 关键设计

### 3.1 Contract 由领域代码和 Reconcile 表达

“Loop 是一个 Task Contract 加 Cron”适合描述边界稳定、步骤已经充分理解的自动化，但不能作为
Baton 的前置条件。把业务细节完整写成 Contract 的成本可能接近直接写代码，而且探索中的目标、
判断和例外本来就会持续变化。Baton 不要求先发明完整 Loop DSL，而允许 Plugin 用普通代码表达
领域模型与 reconcile：

```text
Loop ≈ resource(spec + status) + reconcile
                                  ▲
                 change / result / requeueAfter
```

“Contract + Cron”的声明性方向是对的，但可以进一步落成 Resource：Contract 进入 `spec`，
执行事实进入 `status`，Controller 用代码表达不适合经济地写成 DSL 的判断，`requeueAfter`
表达下一次动态检查。不需要 desired state 的 Plugin 则可直接 watch Baton-owned Resource。
Operator 模型可以帮助区分这些职责，但 Board 不直接等于 CRD：

| Kubernetes Operator | Baton |
|---|---|
| Pod 等内置对象 | Event Ledger 派生出的只读 Baton-owned Resource，例如 `baton.dev/v1alpha1, Kind=Turn` |
| CRD | Plugin 声明的 Resource type 与 `spec/status` schema |
| CR | 一个具体的 Resource，例如某次 ReqLoopRun |
| spec / status | 人认可的 Loop Contract / Controller 观测状态 |
| Controller / Controller | Baton-owned kind Controller 或 Controller 中的 `reconcile()` |
| watch / work queue | Controller resource Source、Resource 变化与 keyed reconcile queue |
| dynamic recheck / periodic resync | `RequeueAfter` → 持久化内部 schedule / Controller cron Source |
| API mutation | Controller 更新 status、调用 Plugin Connector |
| kubectl / status view | Board presentation |

Board 可以展示和编辑 desired state、observed state、condition、证据与待决事项；用户认可的
编辑更新 `spec`，Harness 和外部系统产出作为 observation 进入，再由 Controller 更新 `status`。
一期 Board 可以直接从 Resource 生成展示内容，不先建设一份可独立演化的 Board 数据库。

一期只打通最小的人驱动闭环：

```text
Reconcile
  → 更新 status / Board
  → PluginOutput(kind: proposed-input)
  → 用户审核、编辑或丢弃
  → 普通 Input
  → Harness
  → Harness 产出回到 Resource / Board
```

长期可以让 Controller 通过 Baton 的受控能力主动启动一个或多个 Harness，例如先把用户需求
文字整理成结构化 Requirement，再让不同 agent 分别开发、review 或验证；各 Harness 的产出都
回写为 observation，由 Controller 更新同一个 Resource / Board。这个能力不进入首期，也暂不
为它提前命名独立的顶层 Intent 类型。

### 3.2 从现有 Plugin 体系吸收什么

| 体系 | 吸收 | 不照搬 |
|---|---|---|
| OpenCode | 按领域注册、作用域拥有注册项、关闭作用域时自动撤销 | 向 Plugin 暴露 client、shell 和可变宿主对象；一张不断增长的 Hooks 表 |
| Codex | `plugin@marketplace` 身份、用户级 enabled 配置、不可变能力包、Package Root 与可写 Data 分离 | 只把 Plugin 当静态能力集合，缺少 Baton 所需的 Session Resource 与长期 reconcile 身份 |
| Claude Code | 用户级启用作用域、自包含包、版本隔离、运行中 `/reload-plugins` | 首版不照搬 project/local/managed 多层覆盖，也不用 Hook 形成第二条执行状态机 |

Baton 因此采用“Codex / Claude 的 Package 边界 + OpenCode v2 的 scoped Binding +
Baton 自己的 Instance、Event 和 Attempt 语义”，而不是复制其中任意一套完整 API。

调研参考：

- [OpenCode Plugin 文档](https://opencode.ai/docs/plugins/)
- [OpenCode 当前 Plugin API](https://github.com/anomalyco/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/plugin/src/index.ts)
- [OpenCode v2 Effect 设计](https://github.com/anomalyco/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/plugin/src/v2/effect/README.md)
- [Codex Plugin 文档](https://learn.chatgpt.com/docs/build-plugins)
- [Codex Plugin manifest](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/plugin/src/manifest.rs)
- [Claude Code Plugin 文档](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code Hook 文档](https://code.claude.com/docs/en/hooks)

### 3.3 Plugin 运行时是窄能力边界

Manager 只向 Plugin 暴露完成已注册能力所需的窄入口：

- 当前 BatonSession、PluginInstance 和 Binding 的不可伪造身份；
- Command / Controller / ContextProvider 注册和关闭生命周期；
- 当前 Baton-owned / Plugin-owned Resource 的只读 snapshot、仅限自有 Resource 的受控 status patch，
  以及可信 Board presentation / Resource Context source 入口；
- session-scoped、非持久化的 Toast 输出；持续状态仍归 Resource status / Board；
- session-scoped、由 Baton 持久化并自动附加 Plugin 身份的结构化诊断日志；
- 按 declaration 与权限注入的配置和 secret；
- 受 timeout、取消和输出预算约束的执行上下文。

Plugin 不获得通用 Store、Controller、Harness 或 shell。访问 Meego、GitHub、部署平台等外部
系统由 Plugin 内部 Connector 完成，并受 manifest 权限、Resource owner 和 Reconcile 生命周期
约束。Connector 是 Plugin 内部实现，不提升为 Baton 顶层概念。

### 3.4 当前只支持可信的进程内 Plugin

当前 Package 使用进程内 TypeScript 激活，属于 trusted code。安装前尚无权限审阅或签名校验，
Baton 不宣称提供安全隔离；窄 Plugin 契约的目的首先是稳定架构边界，而不是假装沙箱。

本地 / Git Marketplace 先解决真实 Plugin 的开发、发现和不可变交付。远程 JSON、npm、
自动更新、卸载、签名、依赖解析和独立进程协议留到实际分发与信任需求出现后再做；届时可以让
进程适配层实现同一 Binding / Controller 契约，不需要推翻 Instance / Binding 模型。

### 3.5 目录兑现领域边界

Plugin core 不为每种注册能力建平级子目录；Marketplace 自身有独立的内部子域：

```text
src/plugin/                 # Baton Plugin 领域：Package / Instance / Binding / Controller
└── marketplace/            # Marketplace manifest、注册、发现、安装与加载
reqloop repository          # 独立 Marketplace，只依赖 Baton 公开 Plugin 契约
```

`src/plugin/` 是 Baton core 的 Plugin Manager 边界；独立 reqloop 仓库拥有 Requirement Loop
的领域模型和 Connector。Baton core 除安装注册入口外，不依赖 reqloop 的领域类型。

PluginPackage 与启用配置是用户级资产；Plugin 运行数据仍跟随 BatonSession：

```text
~/.baton/
├── plugin.yaml                             # plugin@marketplace → enabled/version/config
├── plugins/
│   ├── marketplaces.json
│   ├── marketplaces/<marketplaceName>/    # Git source 的本地 checkout
│   └── packages/<marketplace>/<encodedPluginId>/<version>/
└── projects/<projectKey>/
    └── sessions/<batonSessionId>/
        └── plugins/<pluginInstanceId>/
            ├── resources/<group>/<version>/<kind>/<name>.json
            └── proposals/<proposalId>.json
```

Project 只负责组织和发现 BatonSession，不拥有 Plugin runtime。Manager、Controller、Binding
和队列是进程态；恢复时从用户级启用配置和当前 Session 的 Event Ledger、Resource、
Proposal 重建。Baton-owned Resource 不在 `plugins/` 下另存副本。

### 3.6 增量落地

1. 已建立 Package、Instance、Binding 的可信进程内最小契约：启动恢复启用 Instance，激活失败
   整体回滚，解绑和退出统一关闭。
2. 已建立 Resource 通用信封与存储、同 key 不并发的 reconcile queue、持久 Proposal，
   `requeueAfter` due time 与 Controller Resource/cron Sources；所有唤醒都进入同一
   keyed queue；Plugin Resource 创建和有效的 status 更新也自动进入该队列，运行数据全部归当前
   BatonSession。
3. 已建立 `_baton_turn_summary` → `baton.dev/v1alpha1, Kind=Turn` 的只读 Baton-owned Resource，
   `registerController` 复用同一 queue、退避和 Proposal 管线；启动 replay 与 live append
   使用同一资源 key。
4. 已建立本地 / Git Marketplace 注册、仓内 Package 发现、版本化不可变安装和进程内加载；
   用户身份统一为 `plugin@marketplace`，同名 Package 按 Marketplace 隔离。
5. 已以 reqloop 的 `/requirements` 接通 Command：Package 在 Binding 激活期注册，
   Baton 动态合并补全并渲染 message/picker，选择值再路由回同一 Plugin handler；Picker
   支持本地过滤或防抖后的远端 Command 搜索，并丢弃过期响应。
   manifest 的 `command | resource` 声明校验仍随后补齐；多实例出现前保持单一路由，
   多个 active instance 时 fail closed。
6. `proposed-input` Output 已经通过持久 Proposal 投影到 InteractionDock；`interaction`
   Output 已接入 Event Ledger、同 Resource 决议 Snapshot、TUI 回答和重新 reconcile。用户采用、
   编辑并提交 proposed input 后驱动 Harness；Controller 的 `present()` 已接入可选右侧 Sidecar。
   内置 Session 与 Plugin 已通过同一个 ContextProvider Registry 接入分组 `@` 搜索和单 turn
   急切上下文；后续再把需要可靠水位的来源接入持久 Resource Context source。
7. resource Source 已提供初始发现、实时订阅和目标 Resource materialize；reqloop 可直接接入
   devloop 文件变化。无法表达成 desired state 的独立命令出现后再接 Action，不给 Plugin
   预造 Monitor 或私有 timer。
8. 真实 loop 证明必须由 Controller 主动启动 Harness 后，再设计受控调用；首期只允许用户把
   `proposed-input` Output 提交成普通 Input。
9. `/plugins` 首期管理面已接入 Marketplace 浏览、Package 搜索 / 详情 / 安装、用户级
   Plugin 启停和加载错误；新 Session 自动加载，`/reload-plugins` 已接入当前 Session 的 Binding 重建。真实分发
   需求出现后再增加配置、多 Instance 管理、更新、卸载、内容信任和进程隔离，不改变既有
   Instance / Binding 运行模型。
