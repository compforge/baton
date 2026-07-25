# @qiankun01/baton-plugin

Public, host-independent authoring contract for Baton plugins.

```ts
import {
  type PluginActivationContext,
  type PluginPackage,
} from "@qiankun01/baton-plugin";

const plugin: PluginPackage = {
  pluginId: "example/plugin",
  version: "0.1.0",
  activate(context: PluginActivationContext) {
    context.registerResource({
      resourceKind: "Example",
      reconciler: { async reconcile() {} },
      board: {
        project(resource) {
          return [{
            key: "summary",
            title: resource.metadata.resourceId,
          }];
        },
      },
    });
  },
};

export default plugin;
```

This package contains protocol types only. Baton runtime implementations such
as Manager, Binding, Controller, Store, Marketplace, persistence, and Harness
routing are intentionally excluded.
