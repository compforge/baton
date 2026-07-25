const MARKETPLACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PluginIdentity {
  readonly pluginId: string;
  readonly marketplace: string;
}

export function pluginKey(pluginId: string, marketplace: string): string {
  if (!pluginId.trim()) throw new Error("pluginId must not be empty");
  if (!MARKETPLACE_NAME.test(marketplace)) {
    throw new Error("marketplace must be a stable identifier");
  }
  return `${pluginId}@${marketplace}`;
}

export function parsePluginKey(value: string): PluginIdentity {
  const separator = value.lastIndexOf("@");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`plugin identity must be plugin@marketplace: ${value}`);
  }
  const pluginId = value.slice(0, separator);
  const marketplace = value.slice(separator + 1);
  if (pluginKey(pluginId, marketplace) !== value) {
    throw new Error(`plugin identity must be canonical: ${value}`);
  }
  return Object.freeze({ pluginId, marketplace });
}
