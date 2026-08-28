import type { ResourceType } from "@compforge/baton-plugin";

import { resourceTypeKey } from "./resource.ts";

interface BatonRegistration {
  readonly owner: "baton";
}

interface PluginRegistration {
  readonly owner: "plugin";
  readonly pluginId: string;
  controllers: number;
  materialized: boolean;
}

type ResourceTypeRegistration = BatonRegistration | PluginRegistration;

/**
 * Resource GVK registration is first-register-wins; a later Plugin registration
 * never replaces Core or another Plugin.
 */
export class ResourceRegistry {
  private readonly registrations = new Map<string, ResourceTypeRegistration>();

  constructor(batonTypes: readonly ResourceType[]) {
    for (const type of batonTypes) this.registerBaton(type);
  }

  isBaton(type: ResourceType): boolean {
    return this.registrations.get(resourceTypeKey(type))?.owner === "baton";
  }

  registerController(pluginId: string, type: ResourceType): () => void {
    const registration = this.pluginRegistration(pluginId, type);
    registration.controllers += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.registrations.get(resourceTypeKey(type));
      if (
        current?.owner !== "plugin" ||
        current.pluginId !== pluginId
      ) {
        return;
      }
      current.controllers -= 1;
      if (current.controllers === 0 && !current.materialized) {
        this.registrations.delete(resourceTypeKey(type));
      }
    };
  }

  registerMaterialized(pluginId: string, type: ResourceType): void {
    this.pluginRegistration(pluginId, type).materialized = true;
  }

  private registerBaton(type: ResourceType): void {
    const key = resourceTypeKey(type);
    if (this.registrations.has(key)) {
      throw new Error(`Resource type is already registered: ${key}`);
    }
    this.registrations.set(key, { owner: "baton" });
  }

  private pluginRegistration(
    pluginId: string,
    type: ResourceType,
  ): PluginRegistration {
    const key = resourceTypeKey(type);
    const current = this.registrations.get(key);
    if (current?.owner === "baton") {
      throw new Error(`Resource type is already registered by Baton: ${key}`);
    }
    if (current?.owner === "plugin" && current.pluginId !== pluginId) {
      throw new Error(
        `Resource type ${key} is already registered by ${current.pluginId}`,
      );
    }
    if (current?.owner === "plugin") return current;
    const registration: PluginRegistration = {
      owner: "plugin",
      pluginId,
      controllers: 0,
      materialized: false,
    };
    this.registrations.set(key, registration);
    return registration;
  }
}
