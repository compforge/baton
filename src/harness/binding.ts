import {
  isApprovalRoutable,
  isEffortConfigurable,
  isModelConfigurable,
  isSessionConfigurable,
  type ApprovalRoute,
  type EffortOption,
  type EventSink,
  type HarnessAdapter,
  type HarnessSessionBinding,
  type HarnessSessionHandle,
  type HarnessSessionIdentity,
  type ModelOption,
} from "./adapter.ts";
import { newId } from "../event/ids.ts";
import type { ConfigValue, SessionConfigOption } from "../event/types.ts";
import type { SessionHandle } from "../store/store.ts";
import { sessionIdResumeState, type HarnessResumeState } from "./resume.ts";
import { createHarnessLaunchSnapshot, type HarnessTarget } from "./target.ts";

export interface HarnessBindingOptions {
  laneId: string;
  target: HarnessTarget;
  cwd: string;
  adapter: HarnessAdapter;
  session: SessionHandle;
  eventSink: EventSink;
  setupTurnId?: string;
  modelPreference?: string;
  effortPreference?: string;
}

/**
 * 一个 Lane × HarnessTarget 在当前 BatonSession 中的 live 绑定：
 * Lane 可跨 Target 接力；每个 Target 在该 Lane 内拥有自己的 Adapter 与 HarnessSession。
 *
 * 绑定拥有启动、resume、配置恢复与关闭；Turn 调度、上下文注入和 Event 持久化仍由
 * Controller 负责。
 */
export class HarnessBinding {
  readonly laneId: string;
  readonly target: HarnessTarget;
  readonly cwd: string;
  readonly adapter: HarnessAdapter;
  ref?: HarnessSessionHandle;
  /**
   * setup 阶段由哪个 driven turn 触发。无显式 turnId 的 setup Interaction 由
   * Controller 使用它归属到触发冷启动的 turn。
   */
  setupTurnId?: string;
  freshHarnessSession = true;
  /** 当前原生 HarnessSession 的上下文基线身份；resume 保留、fresh 重新签发。 */
  contextEpochId?: string;

  private starting?: Promise<void>;
  private readonly session: SessionHandle;
  private readonly eventSink: EventSink;
  private readonly modelPreference?: string;
  private readonly effortPreference?: string;
  private publishedBinding?: HarnessSessionBinding;

  constructor(options: HarnessBindingOptions) {
    this.laneId = options.laneId;
    this.target = options.target;
    this.cwd = options.cwd;
    this.adapter = options.adapter;
    this.session = options.session;
    this.eventSink = options.eventSink;
    this.setupTurnId = options.setupTurnId;
    this.modelPreference = options.modelPreference;
    this.effortPreference = options.effortPreference;
  }

  get isStarting(): boolean {
    return Boolean(this.starting);
  }

  /**
   * 必须在 Controller 把 binding 放入索引后调用：Adapter.open 期间可能同步打开
   * Interaction，届时 Controller 需要先能按 HarnessTarget 找回本 binding。
   */
  start(): void {
    if (this.starting || this.ref) return;
    this.starting = this.open();
    // ensure() 可能晚一拍才 await；先消费 rejection 防止误报，真实错误仍由 ensure 抛出。
    void this.starting.catch(() => {});
  }

  async ensure(): Promise<void> {
    if (!this.starting) return;
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async listModels(): Promise<ModelOption[]> {
    if (this.ref && isSessionConfigurable(this.adapter)) {
      const option = (await this.adapter.getConfig(this.ref)).find(
        (candidate) => candidate.id === "model" && candidate.type === "select",
      );
      if (option?.type === "select") {
        return option.options.map(({ value, name, description }) => ({
          id: value,
          label: name,
          ...(description ? { description } : {}),
        }));
      }
    }
    if (!this.ref || !isModelConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support /model`);
    }
    return this.adapter.listModels(this.ref);
  }

  async setModel(modelId: string | null): Promise<void> {
    if (!this.ref) {
      throw new Error(`${this.target.id} does not support /model`);
    }
    if (isSessionConfigurable(this.adapter)) {
      await this.adapter.setConfig(this.ref, "model", modelId ?? "default");
    } else if (isModelConfigurable(this.adapter)) {
      await this.adapter.setModel(this.ref, modelId);
    } else {
      throw new Error(`${this.target.id} does not support /model`);
    }
    const targetMeta = this.session.meta.harnessTargets[this.target.id] ?? {
      harnessTargetId: this.target.id,
      harness: this.target.harness,
    };
    this.session.setHarnessTarget(this.target.id, {
      ...targetMeta,
      harnessTargetId: this.target.id,
      harness: this.target.harness,
      model: !modelId || modelId === "default" ? undefined : modelId,
    });
  }

  currentModel(): string | null {
    if (!this.ref || !isModelConfigurable(this.adapter)) {
      return this.preferredModel() ?? null;
    }
    return this.adapter.currentModel(this.ref);
  }

  async listEfforts(): Promise<EffortOption[]> {
    if (this.ref && isSessionConfigurable(this.adapter)) {
      const option = (await this.adapter.getConfig(this.ref)).find(
        (candidate) => candidate.id === "effort" && candidate.type === "select",
      );
      if (option?.type === "select") {
        return option.options.map(({ value, name, description }) => ({
          id: value,
          label: name,
          ...(description ? { description } : {}),
        }));
      }
    }
    if (!this.ref || !isEffortConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support /effort`);
    }
    return this.adapter.listEfforts(this.ref);
  }

  async setEffort(effortId: string | null): Promise<void> {
    if (!this.ref) {
      throw new Error(`${this.target.id} does not support /effort`);
    }
    if (isSessionConfigurable(this.adapter)) {
      await this.adapter.setConfig(this.ref, "effort", effortId ?? "default");
    } else if (isEffortConfigurable(this.adapter)) {
      await this.adapter.setEffort(this.ref, effortId);
    } else {
      throw new Error(`${this.target.id} does not support /effort`);
    }
    const targetMeta = this.session.meta.harnessTargets[this.target.id] ?? {
      harnessTargetId: this.target.id,
      harness: this.target.harness,
    };
    this.session.setHarnessTarget(this.target.id, {
      ...targetMeta,
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
      effort: !effortId || effortId === "default" ? undefined : effortId,
    });
  }

  currentEffort(): string | null {
    if (!this.ref || !isEffortConfigurable(this.adapter)) {
      return this.preferredEffort() ?? null;
    }
    return this.adapter.currentEffort(this.ref);
  }

  approvalRoute(): ApprovalRoute | null {
    if (!this.ref || !isApprovalRoutable(this.adapter)) return null;
    return this.adapter.approvalRoute(this.ref);
  }

  async getConfig(): Promise<SessionConfigOption[]> {
    if (!this.ref || !isSessionConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support session config`);
    }
    return this.adapter.getConfig(this.ref);
  }

  async setConfig(configId: string, value: ConfigValue): Promise<SessionConfigOption[]> {
    if (!this.ref || !isSessionConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support session config`);
    }
    const snapshot = await this.adapter.setConfig(this.ref, configId, value);
    const targetMeta = this.session.meta.harnessTargets[this.target.id] ?? {
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
    };
    const selected = (id: string): string | undefined => {
      const option = snapshot.find(
        (candidate) => candidate.id === id && candidate.type === "select",
      );
      if (!option || option.type !== "select" || option.value === "default") return undefined;
      return option.value;
    };
    this.session.setHarnessTarget(this.target.id, {
      ...targetMeta,
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
      model: selected("model"),
      effort: selected("effort"),
      mode: selected("mode"),
    });
    return snapshot;
  }

  resumeState(): HarnessResumeState | undefined {
    return this.publishedBinding?.resumeState;
  }

  sessionIdentity(): HarnessSessionIdentity | undefined {
    return this.publishedBinding?.identity;
  }

  async close(): Promise<void> {
    if (this.ref) await this.adapter.close(this.ref);
  }

  private preferredModel(): string | undefined {
    return this.session.meta.harnessTargets[this.target.id]?.model ?? this.modelPreference;
  }

  private preferredEffort(): string | undefined {
    return this.session.meta.harnessTargets[this.target.id]?.effort ?? this.effortPreference;
  }

  private preferredMode(): string | undefined {
    return this.session.meta.harnessTargets[this.target.id]?.mode;
  }

  private async open(): Promise<void> {
    try {
      const existing = this.session.meta.lanes[this.laneId]?.harnessSessions[this.target.id];
      const configAdapter = isSessionConfigurable(this.adapter) ? this.adapter : undefined;
      const modelAdapter = isModelConfigurable(this.adapter) ? this.adapter : undefined;
      const effortAdapter = isEffortConfigurable(this.adapter) ? this.adapter : undefined;
      const model = configAdapter || modelAdapter ? this.preferredModel() : undefined;
      const effort = configAdapter || effortAdapter ? this.preferredEffort() : undefined;
      const mode = configAdapter ? this.preferredMode() : undefined;
      this.session.setHarnessTarget(this.target.id, {
        harnessTargetId: this.target.id,
        harness: this.target.harness,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(mode === undefined ? {} : { mode }),
      });
      const launchSnapshot = createHarnessLaunchSnapshot({
        target: this.target,
        harnessSessionKey: this.adapter.harness,
        cwd: this.cwd,
        model,
        effort,
      });
      // open 前落下实际配置：即使进程在 spawn/initialize 期间崩溃，也能解释这次启动。
      this.session.setLaneHarnessSession(this.laneId, this.target.id, {
        ...existing,
        harness: this.adapter.harness,
        launchSnapshot,
      });
      this.ref = await this.adapter.open(
        {
          cwd: this.cwd,
          resumeState:
            existing?.resumeState ??
            (existing?.harnessSessionId
              ? sessionIdResumeState(existing.harnessSessionId)
              : undefined),
          // 兼容尚未迁到版本化 checkpoint 的第三方 adapter。
          resumeSessionId: existing?.harnessSessionId,
        },
        this.eventSink,
        (binding) => this.acceptSessionBinding(binding),
      );
      this.freshHarnessSession = !this.ref.resumed;
      this.contextEpochId =
        this.ref.resumed && existing?.contextEpochId
          ? existing.contextEpochId
          : newId("ctxe");
      if (model) {
        if (configAdapter) await configAdapter.setConfig(this.ref, "model", model);
        else await modelAdapter?.setModel(this.ref, model);
      }
      if (effort) {
        if (configAdapter) await configAdapter.setConfig(this.ref, "effort", effort);
        else await effortAdapter?.setEffort(this.ref, effort);
      }
      if (mode) await configAdapter?.setConfig(this.ref, "mode", mode);
      this.session.setLaneHarnessSession(this.laneId, this.target.id, {
        ...this.session.meta.lanes[this.laneId]?.harnessSessions[this.target.id],
        harness: this.adapter.harness,
        launchSnapshot,
        harnessSessionId: this.sessionIdentity()?.id,
        resumeState: this.resumeState(),
        contextEpochId: this.contextEpochId,
        syncedSeq: this.ref.resumed ? existing?.syncedSeq : 0,
      });
    } finally {
      this.setupTurnId = undefined;
    }
  }

  private acceptSessionBinding(binding: HarnessSessionBinding): void {
    if (
      this.publishedBinding &&
      this.publishedBinding.identity.id !== binding.identity.id
    ) {
      throw new Error(
        `${this.target.id} changed HarnessSession identity from ` +
          `${this.publishedBinding.identity.id} to ${binding.identity.id}`,
      );
    }
    this.publishedBinding = binding;
    const existing = this.session.meta.lanes[this.laneId]?.harnessSessions[this.target.id];
    this.session.setLaneHarnessSession(this.laneId, this.target.id, {
      ...existing,
      harness: this.adapter.harness,
      harnessSessionId: binding.identity.id,
      resumeState: binding.resumeState,
      ...(this.contextEpochId ? { contextEpochId: this.contextEpochId } : {}),
    });
  }
}
