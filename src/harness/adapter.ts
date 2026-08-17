// Adapter 统一抽象："小核心 + 可选能力"（见 docs/harness.md）。
// 各家用原生协议接入，归一成 HarnessEvent 交给 sink；source / harness /
// harnessTargetId 由宿主在可信边界补齐，提交后才成为 Baton Event。

import type {
  ConfigValue,
  PromptBlock,
  SessionConfigOption,
} from "../event/index.ts";
import type {
  InteractionDraft,
  InteractionResult,
} from "../interaction/types.ts";
import type { HarnessResumeState } from "./resume.ts";
import type { HarnessEventSink } from "./event.ts";
import type { HarnessInput } from "./input.ts";

export type { HarnessEvent, HarnessEventSink } from "./event.ts";

/**
 * Adapter 进程内的会话句柄。它只用于把后续调用路由回当前 Adapter 实例，
 * 不能持久化，也不能当作 HarnessSession 的稳定身份。
 */
export interface HarnessSessionHandle {
  harness: string;
  handleId: string;
  /** 是否成功恢复了既有原生会话；false 表示新建，宿主需要从 BatonSession 补历史。 */
  resumed?: boolean;
}

/** HarnessSession 在所属 HarnessTarget 内的稳定身份。 */
export interface HarnessSessionIdentity {
  id: string;
}

/**
 * 当前执行绑定可持久化的部分。Adapter 在身份首次可知以及 checkpoint 更新时主动发布；
 * 宿主不从进程内 handle 猜测稳定身份。
 */
export interface HarnessSessionBinding {
  identity: HarnessSessionIdentity;
  resumeState: HarnessResumeState;
}

export type HarnessSessionBindingSink = (binding: HarnessSessionBinding) => void;

/** provider 原生入站消息的旁路 trace；不进入 session event ledger。 */
export type NativeEventSink = (event: {
  direction: "in";
  name?: string;
  payload: unknown;
}) => void;

export interface OpenOptions {
  cwd: string;
  env?: Record<string, string>;
  /** Adapter 上次返回的版本化恢复状态；adapter 应优先恢复，缺失时新建。 */
  resumeState?: HarnessResumeState;
  /** @deprecated 旧 meta/第三方 adapter 的迁移兼容；新实现使用 resumeState。 */
  resumeSessionId?: string;
}

/**
 * `sendTurn` 的调用参数，不是独立的 Harness IO 概念。ID 都由 controller 分配
 * （见 docs/harness.md）：新 turn 在入队时分配 turnId；
 * same-turn send 复用当前 turnId。harness 侧各自的 turn/message id 只进 raw 或 adapter
 * 内部映射，不进 controller 契约。
 *
 * 普通 prompt 的 `user_message` / `state_update(running)` 由 controller 在出队时落盘
 * （用户输入是 BatonSession 的事实，不等 harness 冷启动；且新 turn 的 blocks 可能
 * 含 <baton-sync> prepend，不能进正典历史）——adapter **不得**为 prompt 重复发这两个
 * 事件；messageId 仅供 same-turn send 成功路径发 delivery:"steer" 的 user_message upsert。
 */
export type PromptInput = Pick<HarnessInput, "turnId" | "messageId" | "blocks"> & {
  /**
   * 跨 harness catch-up 注入（不属于用户输入正文，不进正典历史）。仅当 adapter 声明
   * `capabilities.sync` 时由 controller 传入，adapter 用原生 side-channel 随本次 sendTurn
   * 送达（codex: `turn/start.additionalContext`）——独立注入 user message 会污染原生
   * 历史，text prepend 则把注入混进用户消息并暴露给 UserPromptSubmit hook。
   * 契约：与本 turn 一起送达；admission 失败视为未送达（controller 水位不动，下次重注入）。
   */
  syncBlocks?: PromptBlock[];
};

/** Turn submit 回执：只代表请求被接受，不代表 Turn 完成（见 docs/workflow.md）。 */
export interface PromptReceipt {
  accepted: true;
}

/**
 * `sendTurn` 的 admission 结果。Adapter 以自己的原生运行态决定实际投递：
 *
 * - `new_turn`：没有活跃 turn，已接受开启新 turn 的责任；
 * - `steer`：已接受向 `input.turnId` 对应的当前 turn 投递；若 Harness 内部
 *   还有原生队列，Adapter 按 `steering.deliveryTracking` 约定用
 *   `input_delivery_update` 报告 applied/failed（ack-only 则接受即应用）；
 * - `rejected`：未接受输入，Controller 可安全降级为 queued follow-up。
 *
 * `rejected` 路径不得发事件。throw 同样只允许发生在接受责任之前。
 */
export type SendTurnReceipt =
  | { accepted: true; effective: "new_turn" | "steer" }
  | { accepted: false; effective: "rejected"; reason?: string };

/**
 * 能力标记：用显式 marker object 而不是 TypeScript `{}`（`{}` 会接受几乎所有非 nullish 值），
 * 也不用 boolean——object 给以后扩字段（如支持的 mimeType 列表）留空间。
 */
export interface CapabilityMarker {
  supported: true;
}

/**
 * 可展示的能力 descriptor（见 docs/harness.md）：声明"这个 adapter 支持哪些可选能力"，
 * 供 controller/UI 决策（如不支持 image 时 admission 报错）。
 * 行为仍由可选接口承载（ModelConfigurable、EffortConfigurable、CommandDiscoverable/
 * SessionConfigurable/interaction handler）；契约测试保证"声明支持就必须实现对应接口"。
 */
export interface AdapterCapabilities {
  prompt: {
    image?: CapabilityMarker;
    audio?: CapabilityMarker;
    embeddedResource?: CapabilityMarker;
    resourceLink?: CapabilityMarker;
  };
  /** 声明后必须实现 ContextCompactable：可请求 harness 压缩当前原生会话。 */
  compact?: CapabilityMarker;
  /**
   * sendTurn 原生承载 `PromptInput.syncBlocks`（side-channel 注入）。与 ContextSynchronizable
   * 互斥使用：syncContext 是"急切注入、resolve 即送达"（水位立即推进）；sync 是"随下一次
   * sendTurn 送达"（水位在 admission 通过后推进，语义同 prepend 路径）。都未声明时 controller
   * 回落为把 sync 块 prepend 进 prompt 文本。
   */
  sync?: CapabilityMarker;
  commands?: CapabilityMarker;
  config?: CapabilityMarker;
  /** 声明后必须实现 Reconcilable：可查询 harness 眼中的权威运行态。 */
  reconcile?: CapabilityMarker;
  /** 声明后必须实现 ApprovalRoutable：能报告审批请求当前路由给谁。 */
  approvalRouting?: CapabilityMarker;
  /**
   * 声明后必须实现 TextGeneratable：一次性结构化文本生成（不开 HarnessSession、
   * 不产生 Turn、不进事件流）——session 标题这类旁路工具调用走这里，
   * 由 core 的路由器跨 harness 降级（某家 quota/auth 不可用时换一家）。
   */
  textgen?: CapabilityMarker;
  interactions?: {
    permission?: CapabilityMarker;
    question?: CapabilityMarker;
    elicitation?: { supported: true; form?: CapabilityMarker; url?: CapabilityMarker };
  };
}

/**
 * Adapter 生命周期（见 docs/harness.md）：open 时绑定事件出口，sendTurn 只确认接收，
 * turn 进展与终结全部经 sink 的事件报告；controller 以 state event 驱动 busy/idle，
 * 不以任何 Promise 生命周期推断。
 *
 * 终态硬性约定：每个被 sendTurn 以 `new_turn` 接受的 turn，adapter 在**任何退出路径**（正常结束、
 * wire fatal error、子进程退出、transport close）都必须恰好报告或合成一次
 * `state_update(idle)`；错误路径先发 `_baton_error_update` 再发 idle。重复/迟到的
 * 物理终态允许存在，由 controller 按 baton turn id 幂等 finalize。
 */
export interface HarnessAdapter {
  readonly harness: string;
  readonly capabilities: AdapterCapabilities;
  /**
   * Steer 能力声明；缺省 = 不支持 same-turn steer（sendTurn 应回 rejected）。
   * - `deliveryTracking`：explicit = 接受后必须经 `input_delivery_update` 报告
   *   applied/failed；`ack-only` = 接受即应用，由 Core 合成 applied，无后续回执。
   * - `cancelOwnership`：cancel/interrupt 后原生队列里未应用的 steer 是否仍可达。
   *   survives = Harness 继续拥有并报告回执；unreachable = 不可达，Controller 会在
   *   发 cancel 前把它们收回 Baton Queue。
   */
  readonly steering?: {
    readonly deliveryTracking: "ack-only" | "explicit";
    readonly cancelOwnership: "survives" | "unreachable";
  };
  /**
   * 建立（或恢复）HarnessSession 并绑定事实出口。`binding` 是稳定身份的唯一发布通道；
   * 即使身份要到首个原生事件才出现，Adapter 也必须在可知时立即发布。
   */
  open(
    opts: OpenOptions,
    sink: HarnessEventSink,
    binding: HarnessSessionBindingSink,
  ): Promise<HarnessSessionHandle>;
  /**
   * 发送输入。Adapter 根据自己的活跃 turn 决定开启新 turn、same-turn steer 或拒绝：
   * - 无活跃 turn 时，接受后必须返回 `new_turn`；
   * - `input.turnId` 与活跃 Baton turn 一致时，可以返回 `steer`；
   * - 活跃 turn 不匹配、不可 steer 或原生协议拒绝时返回 `rejected`，不得擅自并行开 turn。
   *
   * throw 只表示 Adapter 尚未接受投递责任；resolve 为 accepted 后的失败必须经事件流
   * 给出终态。入参是闭合的 PromptBlock（非开放 ContentBlock）：不支持的 block 类型
   * 必须在 admission 前报带类型的明确错误，禁止静默丢弃（见 docs/harness.md）。
   */
  sendTurn(ref: HarnessSessionHandle, input: PromptInput): Promise<SendTurnReceipt>;
  /** 请求中断当前 turn；确认以最终 `idle/cancelled` 事件为准，发出后仍接受在途 update */
  cancel(ref: HarnessSessionHandle): Promise<void>;
  close(ref: HarnessSessionHandle): Promise<void>;
}

/** admission 检查：返回 capabilities 未声明支持的 block 类型（text 恒支持） */
export function unsupportedPromptBlocks(
  blocks: PromptBlock[],
  capabilities: AdapterCapabilities,
): string[] {
  const unsupported = new Set<string>();
  for (const block of blocks) {
    if (block.type === "text") continue;
    const marker =
      block.type === "image"
        ? capabilities.prompt.image
        : block.type === "audio"
          ? capabilities.prompt.audio
          : block.type === "resource"
            ? capabilities.prompt.embeddedResource
            : block.type === "resource_link"
              ? capabilities.prompt.resourceLink
              : undefined;
    if (!marker) unsupported.add(block.type);
  }
  return [...unsupported];
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * 可选模型能力。setModel 只影响后续 prompt，不得改变已经在运行的 turn，
 * 让 `/model` 在 harness busy 时也有稳定、跨 harness 一致的语义。
 */
export interface ModelConfigurable {
  listModels(ref: HarnessSessionHandle): Promise<ModelOption[]>;
  setModel(ref: HarnessSessionHandle, modelId: string | null): Promise<void>;
  currentModel(ref: HarnessSessionHandle): string | null;
}

export function isModelConfigurable(adapter: HarnessAdapter): adapter is HarnessAdapter & ModelConfigurable {
  const candidate = adapter as Partial<ModelConfigurable>;
  return (
    typeof candidate.listModels === "function" &&
    typeof candidate.setModel === "function" &&
    typeof candidate.currentModel === "function"
  );
}

export interface EffortOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * 可选推理强度能力。候选值可随当前 model 变化，因此由 adapter 动态返回；setEffort
 * 与 setModel 一样只影响后续 prompt，不改变正在运行的 turn。
 */
export interface EffortConfigurable {
  listEfforts(ref: HarnessSessionHandle): Promise<EffortOption[]>;
  setEffort(ref: HarnessSessionHandle, effortId: string | null): Promise<void>;
  currentEffort(ref: HarnessSessionHandle): string | null;
}

export function isEffortConfigurable(adapter: HarnessAdapter): adapter is HarnessAdapter & EffortConfigurable {
  const candidate = adapter as Partial<EffortConfigurable>;
  return (
    typeof candidate.listEfforts === "function" &&
    typeof candidate.setEffort === "function" &&
    typeof candidate.currentEffort === "function"
  );
}

/**
 * 通用 session 配置能力。每次读写都返回完整快照，因为 model 变化可能联动 effort 等选项。
 * `/model`、`/effort` 只是该快照中 model / thought_level 两项的快捷入口。
 */
export interface SessionConfigurable {
  getConfig(ref: HarnessSessionHandle): Promise<SessionConfigOption[]>;
  setConfig(
    ref: HarnessSessionHandle,
    configId: string,
    value: ConfigValue,
  ): Promise<SessionConfigOption[]>;
}

export function isSessionConfigurable(
  adapter: HarnessAdapter,
): adapter is HarnessAdapter & SessionConfigurable {
  const candidate = adapter as Partial<SessionConfigurable>;
  return (
    typeof candidate.getConfig === "function" &&
    typeof candidate.setConfig === "function"
  );
}

export type ReconcileState =
  | "idle"
  | "active"
  | "waiting_approval"
  | "waiting_input"
  | "unknown";

export interface ReconcileVerdict {
  state: ReconcileState;
  /** Harness 原始状态标识，只用于诊断，不参与通用决策。 */
  detail?: string;
}

/** 可选对账能力：只观察 Harness 当前状态，是否收口由 Controller 决定。 */
export interface Reconcilable {
  reconcile(ref: HarnessSessionHandle, turnId: string): Promise<ReconcileVerdict>;
}

export function isReconcilable(adapter: HarnessAdapter): adapter is HarnessAdapter & Reconcilable {
  return typeof (adapter as Partial<Reconcilable>).reconcile === "function";
}

/**
 * 审批路由的归一值：`user` = 请求进 baton TUI；`delegated` = harness 侧 reviewer 代批
 * （必须留下带 id 的回执，见 docs/approval-lifecycle.md）。harness 的方言词
 * （codex 的 `auto_review` / `guardian_subagent`）在 adapter 边界收口，不越界。
 */
export type ApprovalRoute = "user" | "delegated";

export interface ApprovalRoutable {
  /**
   * 当前**实际生效**的审批路由。
   *
   * 必须是权威值——由 harness 自己解析后报告，不是 baton 从配置意图反推的。反推必错：
   * codex 的 reviewer 解析链含云端下发的企业 requirements（`allowed_approvals_reviewers`），
   * 能覆盖用户 config.toml 里写死的值、也能覆盖启动参数。无法确知时返回 null——
   * 不知道就别声称（不变量 #2），投影据此静默而不是编一个。
   */
  approvalRoute(ref: HarnessSessionHandle): ApprovalRoute | null;
}

export function isApprovalRoutable(adapter: HarnessAdapter): adapter is HarnessAdapter & ApprovalRoutable {
  return typeof (adapter as Partial<ApprovalRoutable>).approvalRoute === "function";
}

/** 一次性结构化生成请求。`jsonSchema` 约束返回值形状（如 `{title: string}`）。 */
export interface TextgenRequest {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  /** 未给 → 由该 adapter 选择默认模型；各 harness 的模型 ID 方言由 adapter 自己收口。 */
  model?: string;
  cwd: string;
  timeoutMs?: number;
}

/**
 * 可选能力：一次性结构化文本生成。刻意不经过 HarnessSession/Turn——标题生成这类
 * 工具调用不该创建原生会话、占用会话上下文或在事件流留痕；失败只影响调用方降级，
 * 对既有会话零副作用。实现应为无状态子进程/独立 query，可被并发调用。
 */
export interface TextGeneratable {
  generateStructured(request: TextgenRequest): Promise<unknown>;
}

export function isTextGeneratable(adapter: HarnessAdapter): adapter is HarnessAdapter & TextGeneratable {
  return typeof (adapter as Partial<TextGeneratable>).generateStructured === "function";
}

/**
 * 可选能力：让 harness 用自己的原生机制压缩当前会话上下文。
 *
 * `turnId` 由 controller 分配；controller 已先发 running 开界，adapter 必须把压缩过程事件绑定
 * 到该 turn，并在所有终结路径发一次 idle。方法 resolve 只表示请求已被接收，不表示压缩完成。
 */
export interface ContextCompactable {
  compactContext(ref: HarnessSessionHandle, turnId: string): Promise<PromptReceipt>;
}

export function isContextCompactable(adapter: HarnessAdapter): adapter is HarnessAdapter & ContextCompactable {
  return typeof (adapter as Partial<ContextCompactable>).compactContext === "function";
}

/** 可把 BatonSession 的缺失历史追加到 harness 自己的 model-visible history。 */
export interface ContextSynchronizable {
  syncContext(ref: HarnessSessionHandle, blocks: PromptBlock[]): Promise<void>;
}

export function isContextSynchronizable(
  adapter: HarnessAdapter,
): adapter is HarnessAdapter & ContextSynchronizable {
  return typeof (adapter as Partial<ContextSynchronizable>).syncContext === "function";
}

/**
 * Adapter 报告 Interaction 时附带的执行坐标与原始协议消息。它们进入 Event 信封，
 * 不混入 Interaction 的稳定内容。
 */
export interface InteractionContext {
  turnId?: string;
  raw?: unknown;
}

/**
 * Harness 的原生 verb 由 Adapter lowering 成 kind-specific draft，再通过这个 Core port
 * 打开 Interaction。Core 负责铸造 identity/requester、先持久化 requested，最后把持久化后的
 * result 送回 Adapter；Adapter 不能把原生 DTO 当成 Core 消息转发。
 */
export type OpenInteraction = (
  draft: InteractionDraft,
  context?: InteractionContext,
) => Promise<InteractionResult>;
