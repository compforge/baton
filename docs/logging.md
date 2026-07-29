# Baton 日志体系

## 理念与概念

Baton 的日志是一条宿主拥有的运维旁路，用于解释“某个组件在运行时发生了什么”。它不参与
Session 重放，也不承载领域状态：

- `session.jsonl` 是用户输入、Harness 输出和控制面事实的正典事件账本；
- `session.log` 是 Baton、Harness adapter 与 Plugin 共用的结构化诊断日志；
- `native-<target>.jsonl` 保存高频、provider 原生协议报文，避免淹没日常诊断。

内部组件和三方 Plugin 使用同一种日志记录模型。每条记录都有 level、source、component 和
message，可附带结构化 attributes、错误链及当前操作坐标。Plugin 只能提供 Plugin 本地内容；
`pluginId`、`pluginInstanceId` 和 Package version 由宿主补齐，不能由 Plugin 伪造。

## 流程

```text
Baton component ─┐
Harness adapter ─┼─> structured LogEntry ─> SessionLogger ─> session.log
Plugin Runner ───┘          │                    │
                            │                    ├─ level filter
                            │                    ├─ value/entry/queue bounds
                            │                    ├─ async serialized writes
                            │                    └─ private file + rotation
                            └─ host-owned provenance
```

调用方只负责在正确的级别提交有用上下文。SessionLogger 统一负责过滤、规范化、容量保护、权限、
轮转和持久化；写日志失败不能改变被观察操作的结果。Runner 的 stdout/stderr 也会被宿主有界
采集，但 Plugin 应优先使用 `context.logger`，因为结构化字段更容易过滤和定位。

## 关键设计

### 一套管线，多种来源

`source` 区分 `baton`、`harness` 和 `plugin`，`component` 标识稳定的代码区域。所有来源进入
同一 session 文件，才能沿一次故障的完整调用链关联控制面、协议适配和扩展行为；高频原始
wire trace 单独存放，只保留协议取证职责。

### 级别表达运维信号

- `debug`：实体列表、路径、查询范围和单次 reconcile 等细节，默认不落盘；
- `info`：生命周期变化和低频聚合结果；
- `warn`：可以继续运行，但需要注意的降级、限流或异常输出；
- `error`：当前操作失败，或组件无法继续履责。

用户通过 `config.yaml` 的 `logLevel` 控制最低落盘级别。排障时临时启用 `debug`，而不是把每次
轮询的实体明细永久提升到 `info`。

### 日志不是状态，也不是秘密存储

Source/Controller 仍通过 Resource status、Interaction 和 Event Ledger 表达可恢复事实。日志可能
被过滤、丢弃或轮转，因此任何正确性判断都不能读取日志。access token、cookie、凭据、完整
环境变量和其它 secret 不得进入 message、attributes、错误或 Runner 输出。

### 查询是宿主能力

`baton logs [session-id]` 读取当前文件及上一代轮转文件，可按最低 level、component 前缀和
Plugin identity 过滤，也可输出原始 NDJSON。Plugin 不自行创建另一份日志文件或实现自己的
轮转与查看命令。
