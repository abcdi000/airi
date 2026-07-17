# AIRI 外置插件开发规范

状态：草案 v1，对齐 `manifest.plugin.airi.moeru.ai` / `apiVersion: "v1"`。

这份规范用于 AIRI 桌面端的外置插件开发。目标是让开发者只用一个文本编辑器、一个 `plugin.airi.json` 和一个 JavaScript 模块，就能开发并导入插件。未来 TypeScript SDK 和插件商店都应该建立在同一套规范上，而不是推翻现在的本地导入格式。

## 基本原则

- 外置插件是 AIRI 未来默认的扩展方式。
- 当前只有两个应用内置插件：`Lumi 主动视觉插件` 和 `Lumi 聊天浮窗插件`。
- 插件必须自包含在一个目录里。
- 插件必须先声明权限，再使用宿主 API。
- 最小插件不应该要求开发者安装依赖、打包或检出 AIRI 源码。
- 插件身份由 manifest 的 `name` 决定，必须稳定。
- 插件商店安装包必须兼容本地目录导入结构。

## 目录结构

最小结构：

```text
my-airi-plugin/
  plugin.airi.json
  index.mjs
```

推荐结构：

```text
my-airi-plugin/
  plugin.airi.json
  package.json
  README.md
  index.mjs
  assets/
  ui/
```

AIRI 会在插件根目录的子目录中查找 `plugin.airi.json`。

## Manifest 规范

文件名必须是 `plugin.airi.json`。

最小示例：

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

规则：

- `apiVersion` 必须是 `"v1"`。
- `kind` 必须是 `"manifest.plugin.airi.moeru.ai"`。
- `name` 在当前 AIRI 安装中必须唯一。
- 桌面端插件优先使用 `entrypoints.electron`。
- `entrypoints.default` 可作为兜底入口。
- 入口路径可以是相对插件目录的路径，也可以是绝对路径。
- `package.json` 可选；如果存在，其 `version` 会被工具读取。

## 入口模块规范

入口文件是 ES Module，可以导出以下生命周期函数：

```js
export async function init(ctx) {
  console.info("[my-airi-plugin] init")
}

export async function setupModules(ctx) {
  console.info("[my-airi-plugin] setupModules")
}
```

生命周期规则：

- `init(ctx)` 在宿主创建插件 session 后运行。
- `init` 返回 `false` 会中止插件启动。
- `setupModules(ctx)` 用于注册工具、绑定、UI 模块等。
- 生命周期函数应尽量幂等，因为开发时可能卸载、重载、热重载。

宿主注入的 `ctx` 大致形状：

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

不同宿主和权限下可用 API 可能不同。插件应该检查 API 是否存在，并优雅降级。

## 权限模型

插件必须在 manifest 中声明权限。权限应该最小化。

权限组：

- `apis`：调用或发送宿主 API。
- `resources`：读取、写入或订阅宿主资源。
- `capabilities`：等待或读取运行时能力。
- `processors`：注册或执行处理器。
- `pipelines`：挂接或发出流水线事件。

权限记录示例：

```json
{
  "key": "proj-airi:plugin-sdk:apis:protocol:resources:providers:list-providers",
  "actions": ["invoke"],
  "label": "读取模型供应商",
  "reason": "用于展示当前已配置的供应商。",
  "required": true
}
```

建议：

- 每个敏感权限都应该写 `reason`。
- 只有插件无法启动时才设置 `required: true`。
- 不要为了未来功能预先申请大权限。
- 宿主没有提供密钥存储 API 前，不要自行保存用户密钥。

## 工具插件

工具插件让意识模型可以调用插件行为，是最低成本的扩展方式。

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

工具 schema 规则：

- 使用 JSON Schema。
- `additionalProperties` 必须为 `false`。
- 为兼容严格 OpenAI-compatible 校验器，所有字段都写入 `required`；可选字段允许 `null`。
- 返回值必须是可结构化克隆的数据：普通对象、数组、字符串、数字、布尔值或 null。
- tool id 在插件内必须稳定且唯一。

工具提示词建议：

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

## UI 插件

UI 插件应优先使用宿主提供的 widget 或 gamelet 能力。除非宿主明确开放窗口 API，否则外置插件不应直接创建 Electron 窗口。

建议：

- UI 在小尺寸下也要可用。
- 配置应通过宿主配置 API 保存。
- 静态资源放在插件目录内。
- 不要加载远程脚本。
- 使用 AIRI 提供的 iframe/Eventa bridge 与宿主通信。

## 导入方法

当前本地导入流程：

1. 打开 AIRI 桌面端。
2. 打开 `设置 -> 插件`。
3. 点击 `添加插件`。
4. 选择包含 `plugin.airi.json` 的插件目录。
5. 点击 `启用`，再点击 `加载`，或点击 `加载已启用`。

手动导入流程：

1. 打开 `设置 -> 插件`。
2. 点击 `打开目录`。
3. 将插件目录放入显示的插件根目录，或放入指向插件目录的符号链接。
4. 点击 `刷新`。

AIRI 默认把外置插件放在项目或安装目录下，而不是隐藏的用户数据目录：

```text
开发版：<AIRI 仓库>\airi\external-plugins
打包版：<AIRI 安装目录>\plugins\v1
```

高级用户可以用 `AIRI_PLUGIN_ROOT` 覆盖默认目录。准确路径以插件设置页显示的路径为准。

未来插件商店也应该安装同样的目录结构，然后复用同一套刷新、启用、加载流程。

## 开发流程

零依赖流程：

1. 复制 `docs/plugin-development/templates/minimal-tool-plugin`。
2. 修改 manifest 的 `name`。
3. 修改 `index.mjs`。
4. 在 `设置 -> 插件` 中导入目录。
5. 开发时启用 `热重载`。

TypeScript 流程：

1. 在独立项目中编写 TypeScript。
2. 打包为一个 ESM 文件，例如 `dist/index.mjs`。
3. 在 `entrypoints.electron` 指向该文件。
4. 除非插件商店定义依赖安装机制，否则运行时依赖应打进包里或随插件附带。

## 兼容规则

插件开发者：

- 不依赖未文档化的 `ctx` 字段。
- 不随意修改宿主传入对象。
- 不直接依赖 Lumi 内部实现，除非 API 明确标记为 Lumi 相关。
- 使用能力检测和优雅降级。

AIRI 宿主：

- 不破坏 `apiVersion: "v1"` manifest 解析。
- 新 API 通过权限和 capability key 增量加入。
- 本地目录导入与插件商店安装保持兼容。
- v1 保留 `init` 和 `setupModules` 生命周期。

## 安全与隐私

宿主和插件商店应强制：

- 启用和加载前展示权限。
- 对敏感权限展示清晰说明。
- 没有网络权限前，不允许静默联网。
- 没有文件权限前，不允许任意文件访问。
- 插件卸载时清理工具、UI 模块和长任务。

插件开发者应：

- 非必要不收集聊天、屏幕等隐私数据。
- 外发数据前明确让用户配置并知情。
- 日志里记录错误，不记录密钥。

## 插件商店提交清单

未来上架插件商店的插件应包含：

- `plugin.airi.json`
- 含 `version`、`author`、`license` 的 `package.json`
- `README.md`
- UI 插件的截图或预览
- 更新日志
- 权限说明
- 已打包的运行时资源
- 不依赖未声明的远程服务

## 当前内置插件

以下两个是应用内置插件，不作为未来扩展分发模型：

- `Lumi 主动视觉插件`
- `Lumi 聊天浮窗插件`

之后新增功能应优先走本规范定义的外置插件模式，除非确实需要修改核心宿主。
