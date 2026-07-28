import type { SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  Transcript,
  type ChatProtocol,
  type Theme,
  useStoreState,
} from "chat-tui";
import {
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";

import {
  MarketplaceRegistry,
  type AvailablePluginPackage,
  type InstalledPluginPackage,
  type RegisteredMarketplace,
} from "../../plugin/marketplace/index.ts";
import type { PluginInstance } from "../../plugin/instance.ts";
import { Manager } from "../../plugin/manager.ts";
import {
  findNewerVersion,
  isPackageInstalled,
  packageInstances,
  pluginBrowserItems,
  pluginPanelHeight,
  type PluginBrowserData,
  type PluginBrowserError,
  type PluginBrowserItem,
  type PluginTab,
} from "./model.ts";

const TABS: ReadonlyArray<{ name: string; description: string; value: PluginTab }> = [
  { name: "Discover", description: "Packages available from registered Marketplaces", value: "discover" },
  { name: "Installed", description: "Plugin Packages installed on this machine", value: "installed" },
  { name: "Marketplaces", description: "Registered Plugin catalogs", value: "marketplaces" },
  { name: "Errors", description: "Marketplace and Package loading errors", value: "errors" },
];

interface PluginScreenProps {
  protocol: ChatProtocol;
  registry: MarketplaceRegistry;
  manager: Manager;
  theme: Theme;
  onBack: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadBrowserData(
  registry: MarketplaceRegistry,
  manager: Manager,
): PluginBrowserData {
  const errors: PluginBrowserError[] = [];
  let available: readonly AvailablePluginPackage[] = [];
  let installed: readonly InstalledPluginPackage[] = [];
  let marketplaces: readonly RegisteredMarketplace[] = [];
  const instances = manager.listInstances();
  const activeInstanceIds = instances
    .filter((instance) => manager.isInstanceActive(instance.pluginInstanceId))
    .map((instance) => instance.pluginInstanceId);
  try {
    available = registry.available();
  } catch (error) {
    errors.push({ source: "discover", message: errorMessage(error) });
  }
  try {
    installed = registry.installed();
  } catch (error) {
    errors.push({ source: "installed", message: errorMessage(error) });
  }
  try {
    marketplaces = registry.list();
  } catch (error) {
    errors.push({ source: "marketplaces", message: errorMessage(error) });
  }
  return {
    available,
    installed,
    instances,
    activeInstanceIds,
    marketplaces,
    errors,
  };
}

export function PluginScreen(props: PluginScreenProps): ReactNode {
  const timeline = useStoreState(props.protocol.stateStore, "timeline");
  const terminal = useTerminalDimensions();
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Transcript
        header={timeline.header}
        items={timeline.items}
        showThoughts={timeline.showThoughts}
        theme={props.theme}
      />
      <PluginPanel
        registry={props.registry}
        manager={props.manager}
        theme={props.theme}
        height={pluginPanelHeight(terminal.height)}
        onBack={props.onBack}
      />
    </box>
  );
}

interface PluginPanelProps {
  registry: MarketplaceRegistry;
  manager: Manager;
  theme: Theme;
  height: number;
  onBack: () => void;
}

interface PluginNotice {
  readonly text: string;
  readonly tone: "success" | "error";
}

function PluginPanel(props: PluginPanelProps): ReactNode {
  const [tab, setTab] = useState<PluginTab>("discover");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<PluginBrowserData>(() =>
    loadBrowserData(props.registry, props.manager),
  );
  const [detail, setDetail] = useState<PluginBrowserItem | null>(null);
  const [notice, setNotice] = useState<PluginNotice>();
  const tabs = useRef<TabSelectRenderable | null>(null);
  const list = useRef<SelectRenderable | null>(null);
  const items = pluginBrowserItems(tab, data, query);

  const openSelected = useCallback(() => {
    const key = String(list.current?.getSelectedOption()?.value ?? "");
    const selected = items.find((item) => item.key === key);
    if (selected) {
      setNotice(undefined);
      setDetail(selected);
    }
  }, [items]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      if (detail) setDetail(null);
      else props.onBack();
      return;
    }
    if (
      key.name === "tab" ||
      ((detail || !query) && (key.name === "left" || key.name === "right"))
    ) {
      key.preventDefault();
      if (key.name === "left" || key.shift) tabs.current?.moveLeft();
      else tabs.current?.moveRight();
      return;
    }
    if (detail) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      if (key.name === "up") list.current?.moveUp();
      else list.current?.moveDown();
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
      key.preventDefault();
      openSelected();
    }
  });

  const chooseTab = (next: PluginTab) => {
    setTab(next);
    setQuery("");
    setDetail(null);
    setNotice(undefined);
  };

  return (
    <box
      border={["top"]}
      borderColor={props.theme.accent}
      style={{
        height: props.height,
        flexShrink: 0,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: props.theme.overlayBackground,
      }}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text fg={props.theme.accent} style={{ width: 12, flexShrink: 0 }}>
          Plugins
        </text>
        <tab-select
          ref={tabs}
          focused={false}
          options={[...TABS]}
          tabWidth={16}
          showDescription={false}
          showUnderline={false}
          showScrollArrows={false}
          wrapSelection
          textColor={props.theme.dim}
          selectedTextColor={props.theme.overlayBackground}
          selectedBackgroundColor={props.theme.accent}
          style={{ flexGrow: 1 }}
          onChange={(_index, option) => {
            if (option) chooseTab(option.value as PluginTab);
          }}
        />
      </box>

      {detail ? (
        <PluginDetail
          item={detail}
          data={data}
          registry={props.registry}
          manager={props.manager}
          theme={props.theme}
          notice={notice}
          onChanged={(nextNotice, selectedPackage) => {
            const nextData = loadBrowserData(props.registry, props.manager);
            setData(nextData);
            if (selectedPackage) {
              const selected = pluginBrowserItems("installed", nextData).find(
                (item) =>
                  item.kind === "installed-package" &&
                  item.package.manifest.pluginId === selectedPackage.pluginId &&
                  item.package.provenance.marketplace === selectedPackage.marketplace &&
                  item.package.manifest.version === selectedPackage.version,
              );
              if (selected) setDetail(selected);
            }
            setNotice(nextNotice);
          }}
          onBack={() => {
            setDetail(null);
            setNotice(undefined);
          }}
        />
      ) : (
        <>
          <box
            border
            borderColor={props.theme.border}
            style={{ height: 3, flexShrink: 0, marginTop: 1 }}
          >
            <input
              focused
              value={query}
              width="100%"
              placeholder={`Search ${tab}`}
              onInput={setQuery}
              onSubmit={openSelected}
            />
          </box>
          {items.length > 0 ? (
            <select
              key={`${tab}:${query}`}
              ref={list}
              focused={false}
              style={{ flexGrow: 1, marginTop: 1 }}
              options={items.map((item) => ({
                name: item.name,
                description: item.description,
                value: item.key,
              }))}
              textColor="#ffffff"
              descriptionColor={props.theme.dim}
              selectedTextColor={props.theme.accent}
              selectedDescriptionColor="#ffffff"
              selectedBackgroundColor={props.theme.border}
              showScrollIndicator
              onSelect={openSelected}
            />
          ) : (
            <text fg={props.theme.dim} style={{ flexGrow: 1, marginTop: 1 }}>
              {emptyMessage(tab, query)}
            </text>
          )}
          <text fg={props.theme.dim}>
            {"type to search · ↑↓ select · enter view · ←→/tab switch section · esc back"}
          </text>
        </>
      )}
    </box>
  );
}

interface PluginDetailProps {
  item: PluginBrowserItem;
  data: PluginBrowserData;
  registry: MarketplaceRegistry;
  manager: Manager;
  theme: Theme;
  notice?: PluginNotice;
  onChanged: (
    notice: PluginNotice,
    selectedPackage?: { pluginId: string; marketplace: string; version: string },
  ) => void;
  onBack: () => void;
}

function PluginDetail(props: PluginDetailProps): ReactNode {
  const [acting, setActing] = useState(false);
  const manifest =
    props.item.kind === "available-package" || props.item.kind === "installed-package"
      ? props.item.package.manifest
      : undefined;
  const marketplace =
    props.item.kind === "available-package"
      ? props.item.package.marketplace
      : props.item.kind === "installed-package"
        ? props.item.package.provenance.marketplace
        : undefined;
  const instances = manifest
    ? packageInstances(manifest.pluginId, marketplace!, manifest.version, props.data)
    : [];
  const installed =
    props.item.kind === "installed-package" ||
    (props.item.kind === "available-package" &&
      isPackageInstalled(props.item.package, props.data.installed));

  // 检测是否有新版本可用
  const newerVersion =
    props.item.kind === "installed-package"
      ? findNewerVersion(props.item.package, props.data.available)
      : undefined;

  const canInstall =
    props.item.kind === "available-package" &&
    !installed;
  const instanceAction =
    installed && instances.length === 0
      ? {
          name: "Enable globally",
          description: "Load in new sessions and activate in this session",
          value: "enable",
        }
      : instances.length === 1
        ? instances[0]!.enabled
          ? {
              name: "Disable globally",
              description: "Deactivate here and skip future sessions",
              value: "disable",
            }
          : {
              name: "Enable globally",
              description: "Load in new sessions and activate here",
              value: "enable",
            }
        : undefined;
  const canUninstall = installed;
  const actions = [
    ...(canInstall
      ? [{ name: "Install and enable", description: "Install globally and activate in this session", value: "install" }]
      : []),
    ...(newerVersion
      ? [{
          name: "Update now",
          description: `Install ${newerVersion.manifest.version} and update the global setting`,
          value: "update",
        }]
      : []),
    ...(instanceAction ? [instanceAction] : []),
    ...(canUninstall
      ? [{ name: "Uninstall package", description: "Remove this Package from Baton", value: "uninstall" }]
      : []),
    { name: "Back to plugin list", description: "Return to the current section", value: "back" },
  ];

  const runAction = async (value: string): Promise<void> => {
    if (acting) return;
    if (value === "back") {
      props.onBack();
      return;
    }
    if (!manifest) return;
    setActing(true);
    try {
      if (value === "install" && props.item.kind === "available-package") {
        const result = props.registry.install(props.item.package.manifest.pluginId, {
          marketplace: props.item.package.marketplace,
        });
        const existing = instances[0];
        if (existing) {
          if (existing.packageVersion !== result.manifest.version) {
            await props.manager.setInstancePackageVersion(
              existing.pluginInstanceId,
              result.manifest.version,
            );
          }
          await props.manager.setInstanceEnabled(existing.pluginInstanceId, true);
        } else {
          await props.manager.createInstance({
            pluginId: result.manifest.pluginId,
            marketplace: result.provenance.marketplace,
            packageVersion: result.manifest.version,
          });
        }
        props.onChanged({
          text: result.alreadyInstalled
            ? `${result.manifest.pluginId}@${result.provenance.marketplace} was already installed and is enabled`
            : `Installed and enabled ${result.manifest.pluginId}@${result.provenance.marketplace}`,
          tone: "success",
        });
        return;
      }
      if (value === "update" && props.item.kind === "installed-package" && newerVersion) {
        props.registry.install(newerVersion.manifest.pluginId, {
          marketplace: newerVersion.marketplace,
        });

        const oldInstances = packageInstances(
          manifest.pluginId,
          props.item.package.provenance.marketplace,
          manifest.version,
          props.data,
        );
        for (const oldInstance of oldInstances) {
          await props.manager.setInstancePackageVersion(
            oldInstance.pluginInstanceId,
            newerVersion.manifest.version,
          );
        }

        const oldVersionIsReferenced = props.manager.listInstances().some(
          (instance) =>
            instance.pluginId === manifest.pluginId &&
            instance.marketplace === marketplace &&
            instance.packageVersion === manifest.version,
        );
        if (!oldVersionIsReferenced) {
          props.registry.uninstall(
            manifest.pluginId,
            props.item.package.provenance.marketplace,
            manifest.version,
          );
        }

        props.onChanged(
          {
            text: `Updated ${manifest.pluginId} from ${manifest.version} to ${newerVersion.manifest.version}`,
            tone: "success",
          },
          {
            pluginId: newerVersion.manifest.pluginId,
            marketplace: newerVersion.marketplace,
            version: newerVersion.manifest.version,
          },
        );
        return;
      }
      if (value === "enable") {
        const instance =
          instances.length === 0
            ? await props.manager.createInstance({
                pluginId: manifest.pluginId,
                marketplace: marketplace!,
                packageVersion: manifest.version,
              })
            : await props.manager.setInstanceEnabled(
                instances[0]!.pluginInstanceId,
                true,
              );
        props.onChanged({
          text: `Enabled ${manifest.pluginId}@${marketplace}`,
          tone: "success",
        });
        return;
      }
      if (value === "disable" && instances.length === 1) {
        await props.manager.setInstanceEnabled(
          instances[0]!.pluginInstanceId,
          false,
        );
        props.onChanged({
          text: `Disabled ${manifest.pluginId}@${marketplace}`,
          tone: "success",
        });
        return;
      }
      if (value === "uninstall") {
        for (const instance of instances) {
          await props.manager.removeInstance(instance.pluginInstanceId);
        }
        props.registry.uninstall(manifest.pluginId, marketplace!, manifest.version);
        props.onChanged({
          text: `Uninstalled ${manifest.pluginId}@${marketplace}`,
          tone: "success",
        });
        return;
      }
    } catch (error) {
      props.onChanged({
        text: `${value === "install" ? "Install" : value === "update" ? "Update" : value === "uninstall" ? "Uninstall" : "Plugin action"} failed: ${errorMessage(error)}`,
        tone: "error",
      });
    } finally {
      setActing(false);
    }
  };

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", marginTop: 1 }}>
      <scrollbox style={{ flexGrow: 1 }} focused={false}>
        {detailContent(
          props.item,
          instances,
          props.data.activeInstanceIds,
          props.theme,
        )}
      </scrollbox>
      {props.notice ? (
        <text
          fg={props.notice.tone === "success" ? props.theme.success : props.theme.error}
          style={{ flexShrink: 0 }}
        >
          {props.notice.text}
        </text>
      ) : null}
      <select
        focused
        showDescription={false}
        style={{ height: actions.length, flexShrink: 0, marginTop: 1 }}
        options={actions}
        selectedTextColor={props.theme.accent}
        selectedBackgroundColor={props.theme.border}
        onSelect={(_index, option) => {
          if (option) void runAction(String(option.value));
        }}
      />
      <text fg={props.theme.dim}>
        {acting ? "working…" : "↑↓ select · enter action · esc back"}
      </text>
    </box>
  );
}

function instanceDetail(
  instance: PluginInstance,
  activeInstanceIds: readonly string[],
): string {
  const status = !instance.enabled
    ? "disabled"
    : activeInstanceIds.includes(instance.pluginInstanceId)
      ? "enabled · active"
      : "enabled · inactive";
  return `${instance.pluginInstanceId} (${status})`;
}

function detailContent(
  item: PluginBrowserItem,
  instances: readonly PluginInstance[],
  activeInstanceIds: readonly string[],
  theme: Theme,
): ReactNode {
  if (item.kind === "available-package" || item.kind === "installed-package") {
    const manifest = item.package.manifest;
    const origin =
      item.kind === "available-package"
        ? item.package.marketplace
        : item.package.provenance.marketplace;
    return (
      <text selectable>
        <strong>{manifest.displayName ?? manifest.pluginId}</strong>
        {`\nPlugin: ${manifest.pluginId}`}
        {`\nVersion: ${manifest.version}`}
        {`\nMarketplace: ${origin}`}
        {manifest.description ? `\n\n${manifest.description}` : ""}
        {instances.length === 0
          ? "\n\nGlobal setting: not enabled"
          : `\n\nInstance${instances.length === 1 ? "" : "s"}:\n${instances
              .map((instance) => instanceDetail(instance, activeInstanceIds))
              .join("\n")}`}
        <span fg={theme.dim}>{`\n\nPackage: ${item.package.packageDir}`}</span>
      </text>
    );
  }
  if (item.kind === "marketplace") {
    const source =
      item.marketplace.source.kind === "local"
        ? item.marketplace.source.path
        : `${item.marketplace.source.url}@${item.marketplace.source.revision}`;
    return (
      <text selectable>
        <strong>{item.marketplace.name}</strong>
        {item.marketplace.manifest.description
          ? `\n\n${item.marketplace.manifest.description}`
          : ""}
        {`\n\nPlugins: ${item.marketplace.manifest.plugins.length}`}
        <span fg={theme.dim}>{`\nSource: ${source}`}</span>
      </text>
    );
  }
  return (
    <text selectable>
      <strong>{`Could not load ${item.error.source}`}</strong>
      <span fg={theme.error}>{`\n\n${item.error.message}`}</span>
    </text>
  );
}

function emptyMessage(tab: PluginTab, query: string): string {
  if (query.trim()) return "No matching plugins";
  if (tab === "discover") {
    return "No plugins available. Add a Marketplace with: baton plugins marketplace add <source>";
  }
  if (tab === "installed") return "No Plugin Packages installed";
  if (tab === "marketplaces") {
    return "No Marketplaces registered. Add one with: baton plugins marketplace add <source>";
  }
  return "No Marketplace or Package errors";
}
