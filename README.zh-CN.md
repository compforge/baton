<p align="center">
  <img src="docs/assets/baton-icon.png" alt="baton 图标" width="144" />
</p>

<h1 align="center">baton</h1>

<p align="center"><strong>像传递接力棒一样，在 coding agents 之间传递上下文。</strong></p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh-CN.md">简体中文</a>
</p>

baton 是一个 terminal-native coding agent 工作区，让 Claude Code、Codex 和 DeepSeek Harness 共享同一段持久对话。切换 agent 不再复制上下文，工作可以随时重新打开，也可以由 Plugin 在一次交互结束后继续推进。

BatonSession 属于用户，而不属于任何 Harness。原生会话可以加速 resume，但即使原生会话无法恢复，baton 仍保留完整的逻辑历史。内置 Harness 只是起点，不是封闭支持列表。

## 为什么选择 baton

多数多 agent 工作流都把人变成了上下文传话筒：复制一份回答、重新解释一次任务，然后祈祷下一个 agent 看到的是同一幅图景。baton 用一个持久工作区替代这种人工接力，让上下文可以延续、agent 保持原生体验，长期工作则通过明确的人与 Plugin 协作继续推进。

![baton 协作工作区](docs/kernel-pipeline_v3.svg)

## 特点

- 在同一个 terminal-native 界面中使用 Claude Code、Codex 和 DeepSeek Harness，切换 Target、模型和模式，同时保留每个 Harness 的原生体验。
- 拥有跨 Harness 的持久 BatonSession：重新打开或 fork 工作、接入原生会话，并把 Session 或 Plugin 上下文带入后续 turn。
- 把一轮对话变成长期工作流：Plugin 可以询问决策、准备可编辑草稿、按计划或事件唤醒，并把任务交给主线或异步支线。
- 从本地或 Git Marketplace 安装三方 Plugin，无需把 provider 凭证交给 baton；每个 Plugin 都在独立、受监管的进程中运行。

## 安装

使用 npm 安装 baton。此外需要至少准备一个受支持的 runtime：已登录的 [Codex CLI](https://github.com/openai/codex)、[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)，或为 DSH Agent SDK 配置好的 DeepSeek Harness JSON-RPC runtime。

```bash
npm install -g @compforge/baton
```

也可以不做全局安装，先体验一次：

```bash
npx @compforge/baton
```

## 快速上手

在项目目录启动 TUI，直接输入任务：

```bash
baton
```

常用命令：

```text
/claude 或 /cc       切换到 Claude Code
/codex 或 /cx        切换到 Codex
/dsh 或 /deepseek    切换到 DeepSeek Harness
/target              选择已配置的 Harness Target
/model               选择当前 Harness 的模型
/effort              设置推理强度
/plan                切换 Plan 模式
/sessions            打开历史 BatonSession
/new                 新建干净的 BatonSession
@                    搜索 Session 和 Plugin 上下文
Ctrl+V               粘贴文本或剪贴板图片
Esc                  中断当前 turn
```

切换命令后可以直接带消息，例如 `/cx review this diff` 或 `/cc implement the fix`，baton 会切换 Harness 并立即发送。

## 在会话之间接力

```bash
baton -c                           # 继续当前项目最近的会话
baton -s bs_01...                  # 按 ID 打开 BatonSession
baton resume [bs_xxx|native-id]    # resume Baton 或原生 Harness 会话
baton fork [bs_xxx|native-id]      # fork 为新的 BatonSession
baton sessions                     # 列出可引用的会话
baton clean                        # 删除超过 30 天未活动的会话
```

baton 可以只读识别 Codex 和 Claude Code 的 Session ID，不会修改它们的文件。它把原生持久历史导入用户拥有的 BatonSession：`resume` 继续源会话，`fork` 则创建一条新的工作分支。后续可以在 prompt 中引用任一会话：

```text
@bs_01... 根据前面 Claude 的分析实现这个功能
```

`baton clean` 默认扫描所有项目，跳过活跃会话，并永久删除每个过期 BatonSession 目录（包括日志和 Plugin 数据）。传入 `--cwd <dir>` 可以只清理一个项目。

## 添加长期工作流

Plugin 可以询问决策、准备可编辑草稿、把 turn 委托给 Harness、更新共享 Board，或由 Resource 变化和计划任务再次唤醒。从本地或 Git Marketplace 安装：

```bash
baton plugins marketplace add ./reqloop
baton plugins available
baton plugins install qiankun/requirement-loop
baton plugins list
```

每个活动的三方 Plugin 都运行在独立、受监管的进程中。某个 Plugin 阻塞或崩溃不会占住终端，provider 凭证仍由对应 Harness 自己持有。

## 配置

首次运行会生成 `~/.baton/config.yaml`：

```yaml
defaultTarget: codex
targets:
  codex:
    harness: codex
    command: [codex, app-server]
  codex2:
    harness: codex
    command: [codex, app-server]
    env:
      CODEX_HOME: /Users/you/.codex2
  claude:
    harness: claude
  dsh:
    harness: dsh
    # command: [dsh-jsonrpc-agent, /absolute/path/to/cordis.yml]
    model: prod
mentionBudgetChars: 4096
showThoughts: true
```

所有配置项见 [`config.yaml.example`](config.yaml.example)。同一 Harness 可以配置多个 Target；Target 级 `env` 可用 `CODEX_HOME` 或 `CLAUDE_CONFIG_DIR` 选择 provider 自己管理的账号目录。路径必须是绝对路径，不要把 token 写进该文件。baton 复用各 Harness 已有的凭证和运行时配置，不复制 provider secret。Codex 审批继续遵循所选 Codex home 的配置，除非该 Target 的 `approvalReviewer` 显式委托；Claude Code 可设置 `targets.claude.executable`；DeepSeek Harness 使用 `targets.dsh.command` 配置的命令。

## 数据留在本机

baton 把配置、附件、Plugin、项目和持久会话历史保存在 `~/.baton/`。每个 Harness 继续拥有自己的原生会话；baton 不修改这些文件，只保存 resume 所需的 binding。使用 `baton logs [session-id]` 可以查看会话对应的私有轮转运维日志。

## License

Apache-2.0
