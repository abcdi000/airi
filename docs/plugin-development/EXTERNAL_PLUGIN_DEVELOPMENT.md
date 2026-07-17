# AIRI External Plugin Development Specification

Status: draft v1, aligned with `manifest.plugin.airi.moeru.ai` / `apiVersion: "v1"`.

This document defines the external plugin contract for AIRI desktop. The goal is that a developer can build a useful plugin with only a text editor, a `plugin.airi.json`, and one JavaScript module. TypeScript helpers and a future plugin store can build on the same contract without changing existing plugins.

## Design Principles

- External plugins are the default extension model. The only application-owned built-in plugins are currently `Lumi 主动视觉插件` and `Lumi 聊天浮窗插件`.
- A plugin must be self-contained inside one directory.
- A plugin must declare permissions before it can use host APIs.
- A plugin should run without requiring AIRI source checkout.
- The minimum viable plugin should not require bundling, package installation, or a build step.
- Plugin identity is stable by manifest `name`; do not use display names as identities.
- Plugin store packages must remain compatible with local directory imports.

## Directory Layout

Minimum:

```text
my-airi-plugin/
  plugin.airi.json
  index.mjs
```

Recommended:

```text
my-airi-plugin/
  plugin.airi.json
  package.json
  README.md
  index.mjs
  assets/
  ui/
```

The host discovers plugins by looking for `plugin.airi.json` inside child directories under the plugin root.

## Manifest Contract

File name: `plugin.airi.json`

Required fields:

```json
{
  "apiVersion": "v1",
  "kind": "manifest.plugin.airi.moeru.ai",
  "name": "example-plugin",
  "permissions": {
    "apis": [],
    "resources": [],
    "capabilities": []
  },
  "entrypoints": {
    "electron": "./index.mjs"
  }
}
```

Rules:

- `apiVersion` must be `"v1"`.
- `kind` must be `"manifest.plugin.airi.moeru.ai"`.
- `name` must be globally unique within one AIRI installation.
- `entrypoints.electron` is preferred for desktop plugins.
- `entrypoints.default` may be used as a fallback.
- Entrypoints may be relative to the plugin directory or absolute paths.
- `package.json` is optional; if present, its `version` is shown in tooling.

## Entrypoint Contract

The entrypoint is an ES module. It can export either or both lifecycle hooks:

```js
export async function init(ctx) {
  console.info("[my-airi-plugin] init")
}

export async function setupModules(ctx) {
  console.info("[my-airi-plugin] setupModules")
}
```

Lifecycle:

- `init(ctx)` runs after the host creates a plugin session.
- Returning `false` from `init` aborts plugin startup.
- `setupModules(ctx)` runs after initialization and should register tools, bindings, widgets, or other modules.
- Hooks should be idempotent. A plugin may be unloaded and reloaded during development.

The injected `ctx` has:

```ts
ctx = {
  channels: {
    host
  },
  apis: {
    tools,
    kits,
    bindings,
    providers,
    gamelets
  }
}
```

Available API groups depend on host runtime and declared permissions. Plugins should check for optional APIs before using them.

## Permission Model

A plugin must declare permissions in the manifest. Use the smallest permission set that can support the plugin.

Permission groups:

- `apis`: invoke or emit host API calls.
- `resources`: read, write, or subscribe to host-owned resources.
- `capabilities`: wait for or snapshot runtime capabilities.
- `processors`: register or execute processing steps.
- `pipelines`: hook or emit pipeline events.

Permission record shape:

```json
{
  "key": "proj-airi:plugin-sdk:apis:protocol:resources:providers:list-providers",
  "actions": ["invoke"],
  "label": "List providers",
  "reason": "Needed to show currently configured providers.",
  "required": true
}
```

Guidelines:

- Add `reason` for every non-obvious permission.
- Mark permissions `required: true` only when the plugin cannot start without them.
- Do not request broad permissions for future features.
- Do not persist secrets unless AIRI provides a dedicated secret storage API.

## Tool Plugins

Tools let the active language model call plugin behavior. Tool plugins are the lowest-friction way to extend Lumi/AIRI.

Low-level registration shape:

```js
export async function setupModules({ apis }) {
  await apis.tools.register({
    tool: {
      id: "say_hello",
      title: "Say Hello",
      description: "Returns a short greeting.",
      activation: {
        keywords: ["hello"],
        patterns: []
      },
      parameters: {
        type: "object",
        properties: {
          name: { type: ["string", "null"] }
        },
        required: ["name"],
        additionalProperties: false
      }
    },
    execute: async (input) => {
      return {
        message: `Hello, ${input?.name || "AIRI"}!`
      }
    }
  })
}
```

Tool schema rules:

- Use JSON Schema objects.
- Use `additionalProperties: false`.
- For OpenAI-compatible strict validators, include every property in `required`; optional values should allow `null`.
- Return structured-clone-safe values only: plain objects, arrays, strings, numbers, booleans, and null.
- Tool ids must be stable and unique within the plugin.

Tool prompt guidance:

```js
await apis.tools.registerToolsetPrompt({
  id: "example-guidance",
  prompt: {
    id: "example-guidance",
    title: "Example Plugin Guidance",
    content: "Use `say_hello` only when the user asks for a greeting."
  }
})
```

## UI Plugins

UI plugins should use host-managed widgets or gamelets when available. A UI plugin should not create raw Electron windows unless the host explicitly exposes a window API.

Recommended UI behavior:

- Keep UI responsive at small sizes.
- Store user-facing configuration through host-provided config APIs when available.
- Keep iframe/widget assets inside the plugin directory.
- Avoid remote scripts in UI assets.
- Use postMessage/Eventa bridges supplied by AIRI rather than direct host access.

## User-Facing Configuration

Plugins that expose configurable behavior must provide a graphical configuration path. Do not require ordinary users to edit JSON, YAML, environment variables, or source files.

Current v1-compatible pattern:

- Register explicit configuration tools, for example `my_plugin_configure`.
- The tool must support reading the current config and saving a patch.
- The tool response should include the effective config and any resolved paths.
- Settings pages may call these tools directly to render plugin-specific forms.
- Config tools should create missing directories when the user asks, validate paths and values, and return actionable errors.

Recommended future manifest extension:

```json
{
  "settings": {
    "schemaVersion": "v1",
    "panels": [
      {
        "id": "main",
        "title": "My Plugin",
        "readTool": "my_plugin_configure",
        "writeTool": "my_plugin_configure",
        "fields": [
          {
            "key": "directory",
            "type": "directory",
            "label": "Storage directory",
            "required": true
          },
          {
            "key": "enabled",
            "type": "boolean",
            "label": "Enable automation"
          },
          {
            "key": "dailyTime",
            "type": "time",
            "label": "Daily run time"
          }
        ]
      }
    ]
  }
}
```

Until the manifest schema accepts `settings`, plugin authors should document the intended fields in `README.md` and expose stable config tools. Host UI authors should prefer form controls such as directory inputs, toggles, time inputs, selects, and sliders over raw JSON editors.

## Import And Installation

Current local import flow:

1. Open AIRI desktop.
2. Open `设置 -> 插件`.
3. Click `添加插件`.
4. Select the plugin directory that contains `plugin.airi.json`.
5. Click `启用`, then `加载`, or use `加载已启用`.

Manual import flow:

1. Open `设置 -> 插件`.
2. Click `打开目录`.
3. Put or symlink a plugin directory under the displayed plugin root.
4. Click `刷新`.

AIRI stores external plugins under the project or app installation plugin root, not the hidden user-data directory:

```text
Development: <AIRI repo>\airi\external-plugins
Packaged:    <AIRI install directory>\plugins\v1
```

Advanced users can override the root with `AIRI_PLUGIN_ROOT`. The exact path is shown in the plugin settings page and should be treated as authoritative.

Future plugin store import should install the same directory shape under the same root, then call the same refresh/load flow.

## Development Workflow

Zero-dependency workflow:

1. Copy `docs/plugin-development/templates/minimal-tool-plugin`.
2. Rename the manifest `name`.
3. Edit `index.mjs`.
4. Import the folder from `设置 -> 插件`.
5. Enable `热重载` while developing.

TypeScript workflow:

1. Write TypeScript in a separate project.
2. Bundle to a single ESM entrypoint such as `dist/index.mjs`.
3. Point `entrypoints.electron` to the bundled file.
4. Keep runtime dependencies bundled or vendored unless the plugin store defines dependency installation.

## Compatibility Rules

Plugin authors:

- Do not rely on undocumented fields in `ctx`.
- Do not mutate objects received from the host unless the API says they are mutable.
- Do not assume Lumi-specific internals unless the API is explicitly Lumi-scoped.
- Prefer capability checks and graceful fallback.

AIRI host:

- Do not break `apiVersion: "v1"` manifest parsing.
- Add new APIs through permissions and capability keys.
- Keep local directory import compatible with plugin store install packages.
- Preserve `init` and `setupModules` lifecycle hooks for v1.

## Security And Privacy

Plugins may be powerful. The host and plugin store should enforce:

- Permission review before enable/load.
- Clear labels and reasons for sensitive permissions.
- No silent network access unless a future network permission exists.
- No arbitrary file access unless a future file permission exists.
- Plugin unload must clean up tools, UI modules, and long-running tasks.

Plugin authors should:

- Avoid collecting private chat/screen data unless required.
- Avoid sending data to external services without explicit user configuration.
- Log errors, not secrets.

## Store Readiness Checklist

A plugin submitted to a future plugin store should include:

- `plugin.airi.json`
- `package.json` with `version`, `author`, `license`
- `README.md`
- Screenshots or UI preview when applicable
- Changelog
- Permission explanations
- Bundled runtime assets
- No undeclared remote dependency requirements

## Known Built-In Plugins

These are application-owned and should not be used as the model for future extension distribution:

- `Lumi 主动视觉插件`
- `Lumi 聊天浮窗插件`

All future feature extensions should prefer the external plugin contract above unless they require core host changes.
