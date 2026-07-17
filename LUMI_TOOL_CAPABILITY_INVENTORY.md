# Lumi Tool Capability Inventory

> 基于当前代码静态扫描整理，扫描重点包括 `apps/stage-tamagotchi/src/renderer/stores/`、`apps/stage-tamagotchi/src/renderer/pages/settings/plugins/`、`packages/stage-ui/src/stores/`、`packages/stage-ui/src/tools/`、`packages/stage-ui/src/libs/lumi-agent/` 以及 Claude Code / MCP 相关主进程文件。本报告不修改业务代码。

## 1. 总览

| 模块名 | 文件路径 | 核心能力 | 当前接入位置 | 是否可被聊天调用 | 是否可被自治调用 | 风险等级 |
| --- | --- | --- | --- | --- | --- | --- |
| Lumi 长期记忆 Store | `packages/stage-ui/src/stores/lumi-memory.ts` | 长期记忆 CRUD、候选写入、语义检索、重复合并、SQLite/持久桥接 | `chat.ts`、设置数据页、记忆工具 | 部分，通过 `lumi_memory_search` | 部分，自治链路目前更多作为上下文来源，未统一工具化 | 中 |
| Lumi 记忆工具 | `packages/stage-ui/src/stores/lumi-memory-tools.ts` | 注册 `lumi_memory_search`，带 guard、语义检索、调试提示 | `packages/stage-ui/src/stores/chat.ts` | 是 | 否，除非自治消息进入普通聊天链路 | 低 |
| Lumi 用户画像 Store | `packages/stage-ui/src/stores/lumi-user-profile.ts` | Core/Dynamic/Daily/Pending、Bootstrap、证据、历史、自动审阅、Prompt 相关上下文 | `chat.ts`、`context-providers/lumi.ts`、设置数据页 | 间接，通过 prompt 注入；没有 LLM tool | 部分，主动视觉和 current_state 会读取或写候选 | 中 |
| Lumi 短期意识状态 | `packages/stage-ui/src/stores/lumi-current-state.ts` | current_state 持久化、prompt 注入、画像候选生成 | `chat.ts`、`context-providers/lumi.ts`、主动视觉 | 间接，通过 prompt 注入；没有 LLM tool | 是，主动视觉读入决策上下文 | 低 |
| Lumi Persona/上下文 Provider | `packages/stage-ui/src/stores/chat/context-providers/lumi.ts` | Lumi 人格锚点、情绪、画像、current_state 注入 | chat context provider | 是，作为系统上下文 | 间接 | 中 |
| Lumi 情绪 Store | `packages/stage-ui/src/stores/lumi-emotion.ts` | 迁移情绪状态、关系门控预览、回合后更新 | `context-providers/lumi.ts`、`chat.ts` | 间接，通过 prompt 注入 | 否 | 低 |
| Lumi Eyes | `packages/stage-ui/src/stores/lumi-eyes.ts` | 聊天图片转文字理解，上下文发布，多图限制 | `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts` | 是，图片消息时自动调用视觉模块后再交给意识模型 | 间接，主动视觉另用屏幕观察链路 | 中 |
| Chat Sync | `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts` | 桌面多窗口聊天同步、图片桥接、用户请求看屏幕桥接、字幕、系统提示 | 主聊天、小窗、主动视觉、日记 | 是，聊天入口 | 是，主动视觉和日记通过它注入隐藏消息 | 高 |
| Chat 主 Store | `packages/stage-ui/src/stores/chat.ts` | 普通聊天流式、工具注册、记忆/画像/current_state 后处理、上下文组装 | 主聊天运行时 | 是 | 间接，自治消息走聊天时会复用 | 高 |
| LLM Tools Registry | `packages/stage-ui/src/stores/llm-tools.ts` | provider 级工具注册、清除、等待注册完成 | 记忆、MCP、Agent、自调节、主动观察工具 | 是 | 是，凡走 LLM tools 的链路可用 | 中 |
| Lumi 主线设置 | `packages/stage-ui/src/stores/lumi-main-timeline.ts` | `maxRecentChatMessagesForPrompt` 限制 | 设置页、自我调节 | 间接 | 是，自我调节可修改 | 低 |
| 主动视觉 Store | `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts` | 截屏、屏幕理解、环境上下文、主动消息、自主决策执行、观察工具注册 | App 启动、插件设置页、聊天“看屏幕”桥接 | 是，注册 `lumi_observe_screen` 类工具并支持聊天桥接 | 是，核心自治入口 | 高 |
| 自主决策 Engine | `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-autonomy.ts` | 决策 prompt、JSON 解析、fallback、风险/预算/设置变更校验、自由意图结构 | 主动视觉 `decideAfterObservation()` | 间接 | 是 | 高 |
| 自主 Life Tick | `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts` | Idea Pool、Life Tick、项目推进、Claude 当前 Todo 执行、反思、休息 | App 启动、主动视觉、自主行动设置页 | 否 | 是 | 高 |
| Lumi Self TodoList | `apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts` | Lumi 自己的 Project/Todo/ProgressNote、下一步选择、完成校验、持久化 | Life Tick、主动视觉设置页 | 否 | 是 | 中 |
| 自我调节 Store | `apps/stage-tamagotchi/src/renderer/stores/lumi-self-adjustment.ts` | 低风险设置调整、系统提示、注册 `lumi_adjust_own_settings` | App 启动、LLM 工具、设置 | 是 | 是，主动视觉可通过本地白名单调整部分设置 | 中 |
| 日记 Scheduler | `apps/stage-tamagotchi/src/renderer/stores/lumi-diary-scheduler.ts` | 定时/手动/自治触发日记写入，收集今日聊天 | 插件设置页、主动视觉 `write_daily_summary` | 否，普通聊天不会直接 tool 调用 | 是，主动视觉可触发 | 中 |
| Lumi Agent Store | `packages/stage-ui/src/stores/lumi-agent.ts` | Claude Code 设置、沙箱任务、任务记忆、任务窗口、注册 `lumi_delegate_to_claude_code` | App 启动、聊天工具、Life Tick | 是 | 是，Life Tick 可调用当前 Todo | 高 |
| Agent 路由/Prompt | `packages/stage-ui/src/libs/lumi-agent/index.ts` | 任务类型路由、权限模式、Claude Code prompt 构造 | `lumi-agent.ts`、测试 | 间接 | 是 | 高 |
| Claude Code 主进程服务 | `apps/stage-tamagotchi/src/main/services/airi/claude-code-agent/index.ts` | 启动/继续/取消任务、日志、权限请求、任务快照 | Electron bridge、`claude-task.vue` | 通过 `lumi-agent.ts` | 通过 `lumi-autonomous-life.ts` | 高 |
| Claude Task 窗口 | `apps/stage-tamagotchi/src/renderer/pages/claude-task.vue` | 任务历史、事件流、权限批准/拒绝、继续任务 | 任务浮窗 | 否 | 间接 | 中 |
| MCP 工具桥 | `packages/stage-ui/src/tools/mcp.ts` | MCP list/call 工具、直接工具生成、唯一工具名、浏览器状态变更后 snapshot | `mcp-tools.ts` | 是 | 否，除非自治消息走聊天链路 | 高 |
| Tamagotchi MCP 注册 | `apps/stage-tamagotchi/src/renderer/stores/mcp-tools.ts` | Electron-backed MCP 工具注册、浏览器使用 guidance、connected 状态 | App/设置 MCP 页 | 是 | 间接 | 高 |
| MCP 配置/服务 | `apps/stage-tamagotchi/src/shared/mcp-config.ts`、`apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts` | MCP 配置文件读写、服务连接状态、工具列表 | 设置 MCP 页、MCP 注册 store | 是，注册后 | 间接 | 高 |
| 插件工具 | `apps/stage-tamagotchi/src/renderer/stores/plugin-tools.ts` | 外置/内置插件工具注册桥 | 插件系统 | 不确定，需要逐个插件确认 | 不确定 | 中 |
| 内置 Widget/Image Journal 工具 | `apps/stage-tamagotchi/src/renderer/stores/tools/builtin/*.ts` | 图片日记、组件/天气等历史工具 | LLM tools/builtin toolset | 可能可调用，需看当前 toolset | 否 | 中 |

## 2. 详细工具清单

### 2.1 Lumi 长期记忆 Store

工具名：`useLumiMemoryStore`

文件路径：`packages/stage-ui/src/stores/lumi-memory.ts`

导出函数 / store 方法：

- `initialize()`
- `initializePersistence()`
- `prewarmSemanticIndex(limit?)`
- `setPersistenceBridge(bridge)`
- `resetToMigratedSnapshot()`
- `search(request)`
- `retrieve(request)`
- `retrieveSemantic(request)`
- `extractCandidates(message, sourceMessageId?)`
- `parseCuratedCandidates(raw, sourceMessageId?)`
- `remember(fragment)`
- `rememberCandidate(candidate, options?)`
- `rememberCandidates(candidates, options?)`
- `updateMemory(memoryId, patch)`
- `updateMemoryStatus(memoryId, status)`
- `forget(memoryId)`
- `deleteMemory(memoryId)`
- `mergeMemories(memoryIds, patch?)`
- `setLatestTopic(sessionId, sourceMessage, topic)`
- `getLatestTopic(sessionId, sourceMessage)`
- `memoryDriver`
- `resetState()`

输入参数：

- 检索：`LumiMemorySearchRequest`，包含 query、userId、personaId、limit 等。
- 写入：`LumiMemoryFragment` 或候选项，包含 type、content、importance、confidence、tags、source 等。
- 更新/删除：memory id 和 patch/status。

输出结果：

- `search()` 返回片段数组。
- `retrieve()` / `retrieveSemantic()` 返回 `LumiMemoryRetrievalResult`，包含 ranked memories、route、vector 使用状态等。
- 写入/更新返回 memory fragment 或状态。

副作用：

- 修改运行时 memory store。
- 通过 persistence bridge 写入 SQLite/持久层。
- 语义检索会加载并缓存 embedding 模型，`prewarmSemanticIndex()` 会预热。

权限风险：

- 中。主要是长期人格资产写入/删除风险，不涉及文件系统越权。

当前调用方：

- `packages/stage-ui/src/stores/lumi-memory-tools.ts`
- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/stores/lumi-agent.ts` 会把 Claude 任务记录写入长期记忆。
- 设置页数据维护组件。

是否已接入聊天链路：是，通过 `lumi_memory_search` 和聊天后记忆写入逻辑。

是否已接入主动观察：间接。主动观察产生的消息若进入聊天链路可影响记忆；主动观察本身没有直接暴露记忆读写工具。

是否已接入 Life Tick：不确定。当前 Life Tick 文件没有直接导入 `useLumiMemoryStore`，更像孤岛。

是否已接入设置页：是，记忆管理/数据维护相关页面。

是否有测试：`packages/stage-ui/src/stores/lumi-memory.test.ts`

### 2.2 Lumi 记忆搜索工具

工具名：`lumi_memory_search`

文件路径：`packages/stage-ui/src/stores/lumi-memory-tools.ts`

导出函数 / store 方法：

- `registerLumiMemoryTools(options?)`
- `clearLumiMemoryTools()`
- `shouldSkipLumiMemorySearch(query)`

输入参数：

```ts
{
  query: string
  topic_window?: string
  topic_hints?: string[]
  limit?: number
}
```

输出结果：

- JSON 字符串，包含 `status`、`query`、`topicWindow`、`route`、`memories[]`、`instruction`。
- status 包括 `evidence_found`、`no_reliable_answer_memory`、`skipped_by_guard`、`correction_turn_not_recall`、`inactive_persona` 等。

副作用：

- 可追加绿色 memory_search 调试提示。
- 读取当前 session 最近用户消息以构造 contextual query。

权限风险：

- 低到中。只读长期记忆，但错误使用会导致“编造记忆”风险；工具提示中已有不要猜测的规则。

当前调用方：

- `packages/stage-ui/src/stores/chat.ts` 在 Lumi 卡片激活时注册。

是否已接入聊天链路：是。

是否已接入主动观察：否，主动观察若要用它需要通过普通聊天工具链。

是否已接入 Life Tick：否。

是否已接入设置页：否，设置页管理的是 store 数据，不是该 LLM tool。

是否有测试：`packages/stage-ui/src/stores/lumi-memory-tools.test.ts`

### 2.3 Lumi 用户画像 Store

工具名：`useLumiUserProfileStore`

文件路径：`packages/stage-ui/src/stores/lumi-user-profile.ts`

导出函数 / store 方法：

- `initializePersistence()`
- `reloadFromDatabase()`
- `setPersistenceBridge(bridge)`
- `applyCandidate(candidate, input)`
- `applyCandidates(candidates, input)`
- `previewBootstrapProfile(version?)`
- `importBootstrapProfile(input)`
- `createManualEntry(input)`
- `updateEntry(entryId, patch)`
- `deleteEntry(entryId)`
- `rollbackEntry(entryId, historyId?)`
- `approvePending(pendingId)`
- `approvePendingAutomatically(pendingId, decision)`
- `markPendingAutoReview(pendingId, decision)`
- `consolidatePendingUpdates()`
- `rejectPending(pendingId)`
- `setAutoUpdateEnabled(enabled)`
- `clearProfile()`
- `exportSnapshot()`
- `buildRelevantContext(input)`
- `parseCuratorOutput(raw)`
- `extractDeterministicCandidates(text)`
- `resetState()`
- prompt helpers: `buildLumiUserProfileCuratorPrompt()`、`buildLumiUserProfileCuratorUserPayload()`、`buildLumiUserProfilePendingAutoReviewPrompt()`、`buildLumiUserProfilePendingAutoReviewUserPayload()`、`parseLumiUserProfilePendingAutoReviewOutput()`、`buildBootstrapProfileCandidates()`

输入参数：

- 候选画像：layer、key、value、confidence、sourceKind、evidence。
- 持久化桥：entries、pending updates、events、meta。
- prompt 相关：当前消息、已有画像、待审阅项。

输出结果：

- apply 结果：`stored`、`pending`、`skipped`。
- `buildRelevantContext()` 返回可注入 prompt 的精简画像文本。
- 导出 snapshot 包含 entries、pendingUpdates、events、bootstrapVersion。

副作用：

- 写入 profile entries、pending updates、history/events。
- 通过 persistence bridge 写入 SQLite。
- 自动审阅可批准待确认更新。

权限风险：

- 中。会改变长期用户理解；protected/bootstrap 逻辑降低了漂移风险。

当前调用方：

- `packages/stage-ui/src/stores/chat.ts`
- `packages/stage-ui/src/stores/chat/context-providers/lumi.ts`
- `packages/stage-ui/src/stores/lumi-current-state.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts`
- `apps/stage-tamagotchi/src/renderer/pages/settings/data/components/lumi-user-profile-section.vue`

是否已接入聊天链路：是，聊天后提取候选、自动审阅，并在 prompt 中注入相关画像。

是否已接入主动观察：部分，主动视觉读取 `buildRelevantContext()`；观察结果是否作为画像候选取决于是否进入聊天/当前状态链路。

是否已接入 Life Tick：不确定，Life Tick 文件未直接读取 profile store。

是否已接入设置页：是。

是否有测试：`packages/stage-ui/src/stores/lumi-user-profile.test.ts`

### 2.4 Lumi 短期意识状态 current_state

工具名：`useLumiCurrentStateStore`

文件路径：`packages/stage-ui/src/stores/lumi-current-state.ts`

导出函数 / store 方法：

- `setPersistenceBridge(bridge)`
- `initializePersistence()`
- `saveCurrentState(next)`
- `clearCurrentState()`
- `buildPromptContext()`
- `buildProfileCandidatesFromState()`
- `exportSnapshot()`
- helpers: `buildLumiCurrentStateUpdatePrompt()`、`buildLumiCurrentStateUpdateUserPayload()`、`parseLumiCurrentStateUpdateOutput()`

输入参数：

- current_state patch：recentTopics、userRecentMood、recentImportantDecisions、activeProjects、unfinishedTasks、relationshipContext、lumiViews、lastContinuationPoint、turnCount 等。
- 更新 prompt：previousState、profileContext、recentMessages。

输出结果：

- prompt context 文本。
- profile candidates：current_focus、active_project、unresolved_problem、mood 等。

副作用：

- 写入短期状态持久层。
- 可向用户画像系统输出候选证据。

权限风险：

- 低到中。短期状态不应覆盖 Core Profile，但候选进入画像后有长期影响。

当前调用方：

- `packages/stage-ui/src/stores/chat.ts`：每隔 N 轮更新。
- `packages/stage-ui/src/stores/chat/context-providers/lumi.ts`：注入 prompt。
- `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts`：决策输入。

是否已接入聊天链路：是。

是否已接入主动观察：是，作为决策上下文。

是否已接入 Life Tick：未见直接接入。

是否已接入设置页：短期记忆页/相关设置页应接入；本次未逐行核对页面。

是否有测试：未在扫描结果中看到独立 `lumi-current-state.test.ts`，但 context provider 测试覆盖部分 prompt 注入。

### 2.5 Lumi Persona/上下文 Provider

工具名：`createLumiContext`

文件路径：`packages/stage-ui/src/stores/chat/context-providers/lumi.ts`

导出函数 / store 方法：

- `createLumiContext(input)`

输入参数：

```ts
{
  messageText?: string
  sessionId?: string
}
```

输出结果：

- `ContextMessage | null`，Lumi 卡片激活时返回系统上下文。

副作用：

- 初始化 card/emotion/current_state/profile store。

权限风险：

- 中。它是人格、边界、工具使用规则的核心 prompt 注入点。

当前调用方：

- chat context 系统。

是否已接入聊天链路：是。

是否已接入主动观察：主动观察走聊天时会间接受益。

是否已接入 Life Tick：否。

是否已接入设置页：否。

是否有测试：`packages/stage-ui/src/stores/chat/context-providers/lumi.test.ts`

### 2.6 Lumi Eyes 聊天识图

工具名：`useLumiEyesStore`

文件路径：`packages/stage-ui/src/stores/lumi-eyes.ts`

导出函数 / store 方法：

- `analyzeAttachmentsForChat(input)`
- `publishChatImageContext(input)`
- `buildLumiChatImageContextText(...)`

输入参数：

```ts
{
  attachments: LumiEyesChatAttachment[]
  userMessage: string
  sessionId?: string
}
```

输出结果：

```ts
{
  results: string[]
  errors: string[]
  contextText: string
}
```

副作用：

- 发布图片理解上下文。
- 调用视觉模块 provider。

权限风险：

- 中。会把用户发送图片交给视觉 provider；需依赖视觉模块配置和隐私边界。

当前调用方：

- `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts` 在 attachments 存在时先调用它，再把 `contextText` 作为 hidden provider context 交给意识模型。

是否已接入聊天链路：是。

是否已接入主动观察：否，主动观察使用屏幕截图链路。

是否已接入 Life Tick：否。

是否已接入设置页：视觉 provider 设置页。

是否有测试：`packages/stage-ui/src/stores/lumi-eyes.test.ts`

### 2.7 Chat Sync / 聊天入口桥

工具名：`useChatSyncStore`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts`

导出函数 / store 方法：

- `initialize(mode)`
- `requestIngest(payload)`
- `requestRetry(payload)`
- `requestCleanup(sessionId?)`
- `requestDeleteMessage(payload)`
- `waitForAuthority(timeoutMs)`
- `dispose()`
- 内部：`executeIngest()`、`executeRetry()`、`resolveTools()`、`appendSystemNotices()`、`postAssistantCaptionFromNewMessages()`

输入参数：

- `IngestCommandPayload`：text、attachments、sessionId、toolset、hiddenUserMessage、systemNotices、input、suppressAssistantTexts 等。

输出结果：

- 跨窗口 command/response；最终由 chat orchestrator 写入消息。

副作用：

- 添加用户消息/系统提示/助手回复。
- 图片消息先调 `Lumi Eyes`。
- 用户明确要求“看屏幕”时调 `useLumiProactiveVisionStore().observeScreenForChatTool()`。
- 发字幕 channel。

权限风险：

- 高。它是主聊天入口，会触发模型、工具、视觉和系统提示写入。

当前调用方：

- 主聊天页 `apps/stage-tamagotchi/src/renderer/pages/index.vue`
- 浮窗 `apps/stage-tamagotchi/src/renderer/pages/chat-mini.vue`
- 主动视觉 `lumi-proactive-vision.ts`
- 日记 scheduler `lumi-diary-scheduler.ts`
- InteractiveArea 语音/输入区域。

是否已接入聊天链路：是。

是否已接入主动观察：是。

是否已接入 Life Tick：间接，主动视觉可触发 Life Tick；Life Tick 本身不通过 chat-sync。

是否已接入设置页：否。

是否有测试：`apps/stage-tamagotchi/src/renderer/stores/chat-sync.test.ts`、`chat-sync-lifecycle.test.ts`

### 2.8 主动视觉 Store

工具名：`useLumiProactiveVisionStore`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts`

导出函数 / store 方法：

- `refreshSources()`
- `selectSource(nextSourceId)`
- `runTick(options?)`
- `observeScreenForChatTool(reason)`
- `registerObserveScreenTool()`
- `clearObserveScreenTool()`
- `start()`
- `stop(options?)`
- `resetState()`
- `decideAfterObservation(entry, repeated, messages)`
- `executeAutonomousDecision(sessionId, entry, decision)`
- `recordDecisionLog(input)`
- `buildReturnSummaryContext()`

主要状态：

- `enabled`、`running`、`processing`、`sourceId`、`minIntervalMs`、`maxIntervalMs`、`cooldownMs`
- `autonomousEnabled`、`quietMode`、`summaryMode`
- `idleDailyMaxMessages`、`agentSuggestionCooldownMs`、`observationNoEffectThreshold`
- `allowAutonomousSandboxTasks`、`lumiWorldRoot`
- `decisionLog`、`privateNotes`、`runtimeLogs`、`settingChangeAudit`
- `currentActivity`、`lastSalience`、`environmentContext`

输入参数：

- 定时 tick 配置。
- 截屏 source id。
- 聊天工具 reason。
- 决策输入来自观察文本、当前聊天、current_state、profile、self todo、Life Tick、agent 状态等。

输出结果：

- 屏幕观察文本。
- 系统提示。
- 自主决策日志。
- 可触发普通聊天消息、私密笔记、日记、设置调整、Life Tick。

副作用：

- 截屏和调用视觉模型。
- 写入环境上下文和系统提示。
- 调用 Chat Sync 让 Lumi 主动发言。
- 调用 `useLumiAutonomousLifeStore().runLifeTick()` 推进内部项目。
- 注册聊天可调用的观察屏幕工具。

权限风险：

- 高。涉及屏幕捕获、视觉模型、主动消息、设置变更、沙箱任务入口。

当前调用方：

- `apps/stage-tamagotchi/src/renderer/App.vue`
- `apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts`
- `apps/stage-tamagotchi/src/renderer/pages/settings/plugins/index.vue`
- `apps/stage-tamagotchi/src/renderer/pages/chat-mini.vue`

是否已接入聊天链路：是，通过工具注册和“用户要求看屏幕”的桥接。

是否已接入主动观察：是，核心模块。

是否已接入 Life Tick：是，执行自主决策时可调用 Life Tick。

是否已接入设置页：是，插件设置页“Lumi 主动视觉插件”。

是否有测试：没有看到独立 `lumi-proactive-vision.test.ts`；自主决策测试覆盖部分逻辑。

### 2.9 自主决策 Engine

工具名：`lumi-proactive-autonomy`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-autonomy.ts`

导出函数 / store 方法：

- `buildAutonomousDecisionPrompt(input)`
- `parseAutonomousDecision(raw, input)`
- `fallbackAutonomousDecision(input)`
- `sanitizeAutonomousDecision(decision, input)`
- `evaluateAutonomousSettingChange(input)`

主要类型：

- `LumiAutonomyMode`
- `LumiAutonomyBudget`
- `LumiAutonomousDecisionInput`
- `LumiAutonomousDecisionOutput`
- `LumiAutonomousExecutionPlan`
- `LumiAutonomousDecisionLogEntry`
- `LumiAutonomousTargetSpace`
- `LumiAutonomousVisibility`

输入参数：

- 屏幕观察、聊天状态、未回应次数、今日发言数、当前设置、用户画像、current_state、日记/私密笔记摘要、权限、Self Todo/Life Tick 状态、预算。

输出结果：

- 结构化决策：mode/action、desire、motivation、plan、targetPath、targetSpace、visibility、riskLevel、confidence、requiresUserConfirmation、executionPlan。

副作用：

- 本文件主要是纯决策/校验函数；实际执行在 `lumi-proactive-vision.ts`。

权限风险：

- 高。错误的 prompt 或 sanitize 会让 Lumi 过度沉默、过度发言或越权行动。

当前调用方：

- `lumi-proactive-vision.ts`
- 单元测试。

是否已接入聊天链路：间接，主动发言时进入聊天。

是否已接入主动观察：是。

是否已接入 Life Tick：是，决策可选择 `continue_self_project`、`generate_or_select_idea`、`reflect` 等。

是否已接入设置页：设置页显示决策日志/统计。

是否有测试：`apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-autonomy.test.ts`

### 2.10 Lumi Self TodoList

工具名：`useLumiSelfTodoStore`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts`

导出函数 / store 方法：

- `createProject(input)`
- `updateProject(projectId, patch)`
- `pauseProject(projectId, reason?, source?)`
- `resumeProject(projectId, source?)`
- `completeProject(projectId, input?)`
- `abandonProject(projectId, reason?, source?)`
- `deleteProject(projectId)`
- `addTodo(projectId, input)`
- `updateTodo(projectId, todoId, patch, source?)`
- `startTodo(projectId, todoId, source?)`
- `completeTodo(projectId, todoId, result?, source?)`
- `blockTodo(projectId, todoId, reason, source?)`
- `recoverTransientClaudeBlockedTodos(source?)`
- `cancelTodo(projectId, todoId, reason?, source?)`
- `reorderTodos(projectId, todoIds)`
- `addProgressNote(projectId, input)`
- `getActiveProjects()`
- `getNextExecutableTodo(projectId?)`
- `getProjectProgress(projectId)`
- `createSelfProjectFromDecision(input)`
- `addSelfTodoFromDecision(input)`
- `clearAllForDebug()`

输入参数：

- Project：title、purpose、motivation、targetPath、priority、status、source。
- Todo：content、description、dependsOn、order、source。

输出结果：

- Project/Todo/ProgressNote 对象。
- Project completion check：todoCompletionRate、hasDeliverable、deliverablePaths、hasProgressSummary、canComplete、reason。

副作用：

- 持久化 Lumi 自己的项目和 todo。
- 状态变化时写绿色 system_notice 调试提示。

权限风险：

- 中。它只是规划/状态，但 targetPath 可影响后续 Agent 执行。

当前调用方：

- `lumi-autonomous-life.ts`
- `lumi-proactive-vision.ts`
- `apps/stage-tamagotchi/src/renderer/pages/settings/plugins/index.vue`

是否已接入聊天链路：否，没有作为 LLM tool 注册。

是否已接入主动观察：是，主动视觉读取状态并可触发 Life Tick。

是否已接入 Life Tick：是，核心依赖。

是否已接入设置页：是。

是否有测试：`apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.test.ts`

### 2.11 Lumi Autonomous Life Tick

工具名：`useLumiAutonomousLifeStore`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts`

导出函数 / store 方法：

- `addIdea(input)`
- `updateIdeaStatus(id, status, reason?)`
- `convertIdeaToProject(ideaId)`
- `generateCandidateIdeas()`
- `setRest(reason, delayMs?)`
- `clearRest()`
- `addReflection(reflection)`
- `reflectProject(projectId)`
- `runLifeTick(options?)`
- `advanceCurrentTodo(options?)`
- `runClaudeForCurrentTodo(project, todo)`
- `start()`
- `stop()`
- `clearAllForDebug()`
- pure helpers: `normalizeLifeStorage()`、`loadLifeStorage()`、`scoreIdea()`、`selectIdeaForProject()`、`decideLifeTick()`、`validateLumiWorldTarget()`、`buildClaudeTodoStepPrompt()`、`createReflectionFromProject()`

输入参数：

- Life Tick options：`force?`、`useClaude?`。
- Idea：title、description、motivation、origin、scores、risk、targetSpace。
- Claude 当前 Todo：project、todo、LumiWorld root、权限边界。

输出结果：

- `LumiLifeTickResult`：decision、acted、changedTodoIds。
- Idea、Reflection、RestState、Life log。

副作用：

- 自动选择 idea 转项目。
- 启动/完成/block todo。
- 调用 Claude Code 执行一个小步骤。
- 记录日志、反思、休息状态。

权限风险：

- 高。可触发 Agent 在 LumiWorld/LumiSandbox 内写文件，需沙箱约束。

当前调用方：

- `apps/stage-tamagotchi/src/renderer/App.vue`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts`
- `apps/stage-tamagotchi/src/renderer/pages/settings/plugins/index.vue`

是否已接入聊天链路：否。

是否已接入主动观察：是，主动视觉可触发。

是否已接入 Life Tick：是，核心模块。

是否已接入设置页：是。

是否有测试：`apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.test.ts`

### 2.12 自我调节 Store

工具名：`lumi_adjust_own_settings`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/lumi-self-adjustment.ts`

导出函数 / store 方法：

- `setProactiveVisionTiming(payload)`
- `setConsciousnessModel(payload)`
- `setOllamaThinkingMode(payload)`
- `setSpeechPlaybackVolume(payload)`
- `setLumiPromptHistoryLimit(payload)`
- `executeAdjustment(payload)`
- `createSelfAdjustmentTool()`
- `registerTool()`
- `clearTool()`
- `initializeToolRegistration()`
- `resetState()`

输入参数：

- action + reason + payload。
- 可调节项包括主动视觉时间、意识模型、Ollama thinking、发声音量、Lumi prompt 历史条数。

输出结果：

- JSON 字符串状态：success/rejected 等。
- 系统提示记录改动。

副作用：

- 修改对应设置 store/local storage。
- 写绿色 system_notice。

权限风险：

- 中。已限制为低风险白名单，但意识模型可改变运行行为。

当前调用方：

- `apps/stage-tamagotchi/src/renderer/App.vue` 初始化注册。
- LLM tools store。

是否已接入聊天链路：是，注册为 LLM tool。

是否已接入主动观察：部分，主动观察还有自己的 `applyAutonomousSettingsPatch()`；二者能力重叠。

是否已接入 Life Tick：否。

是否已接入设置页：是，对应设置会同步变更。

是否有测试：未看到独立测试。

### 2.13 日记 Scheduler

工具名：`useLumiDiarySchedulerStore`

文件路径：`apps/stage-tamagotchi/src/renderer/stores/lumi-diary-scheduler.ts`

导出函数 / store 方法：

- `writeToday(trigger?)`
- `checkAndRun()`
- `start()`
- `stop()`
- `resetState()`

输入参数：

- trigger：`scheduled`、`manual`、`autonomous`。
- 今日聊天记录由 active session 收集。

输出结果：

- 日记写入结果通过聊天系统提示/插件 authority 返回。

副作用：

- 通过 `chatSyncStore.requestIngest()` 将今日聊天/观察摘要发给日记插件/链路。
- 设置每日定时器。

权限风险：

- 中。会把聊天记录汇总给模型并写入文件。

当前调用方：

- 插件设置页。
- 主动视觉 `write_daily_summary` 行动。

是否已接入聊天链路：否，不作为 LLM tool；但内部调用 chat-sync。

是否已接入主动观察：是。

是否已接入 Life Tick：未见直接接入。

是否已接入设置页：是。

是否有测试：未看到独立 `lumi-diary-scheduler.test.ts`。

### 2.14 Lumi Agent / Claude Code

工具名：`lumi_delegate_to_claude_code`

文件路径：

- `packages/stage-ui/src/stores/lumi-agent.ts`
- `packages/stage-ui/src/libs/lumi-agent/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/claude-code-agent/index.ts`
- `apps/stage-tamagotchi/src/renderer/pages/claude-task.vue`

导出函数 / store 方法：

- Store：`setBridge()`、`refreshRecentLogs()`、`openTaskWindow()`、`pickClaudeCommand()`、`searchClaudeCommand()`、`runClaudeTask()`、`registerTool()`、`clearTool()`、`initializeToolRegistration()`、`resetSettings()`
- Lib：`routeAgentTask(userRequest, settings)`、`buildClaudeCodePrompt(params)`
- Bridge：`runClaudeTask`、`cancelClaudeTask`、`listClaudeTasks`、`getClaudeTaskLog`、`openClaudeTaskWindow` 等。

输入参数：

```ts
{
  userRequest: string
  permissionMode?: AgentPermissionMode
  workingDirectory?: string
  condaEnv?: string
  continueFromTaskName?: string
  continueFromTaskId?: string
}
```

输出结果：

- status：running/success/failed/blocked/timeout 等。
- taskId、displayName、summary、changedFiles/createdFiles/modifiedFiles/deletedFiles、stdout/stderr preview、error。

副作用：

- 启动 Claude Code CLI。
- 在沙箱或指定目录创建/修改文件。
- 打开独立任务窗口。
- 写任务日志和长期记忆记录。

权限风险：

- 高。涉及文件系统、进程执行、沙箱边界、命令路径。

当前调用方：

- LLM tools 注册。
- `lumi-autonomous-life.ts` 通过 `runClaudeForCurrentTodo()` 执行当前 Todo。
- 任务窗口页面。

是否已接入聊天链路：是。

是否已接入主动观察：间接，通过 Life Tick。

是否已接入 Life Tick：是。

是否已接入设置页：是，动作/Agent 设置。

是否有测试：

- `packages/stage-ui/src/libs/lumi-agent/index.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/claude-code-agent/index.test.ts`

### 2.15 MCP 工具桥

工具名：MCP runtime tools，如 `mcp_<server>_<tool>`，以及代理工具。

文件路径：

- `packages/stage-ui/src/tools/mcp.ts`
- `apps/stage-tamagotchi/src/renderer/stores/mcp-tools.ts`
- `apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.ts`
- `apps/stage-tamagotchi/src/shared/mcp-config.ts`

导出函数 / store 方法：

- `createMcpTools(runtime)`
- `createMcpRuntimeTools(runtime)`
- `mcp()`
- `useTamagotchiMcpToolsStore().refresh()`
- `useTamagotchiMcpToolsStore().dispose()`

输入参数：

- runtime：`listTools()`、`callTool(payload)`。
- direct tool 参数由 MCP server 的 inputSchema 决定。

输出结果：

- LLM Tool[]。
- MCP call result 文本/JSON。
- 对 browser state-changing tools，代码会尝试 follow-up snapshot。

副作用：

- 可调用外部 MCP server，包括浏览器自动化、文件/网络类能力。

权限风险：

- 高。取决于 MCP server；Playwright MCP 可操作浏览器。

当前调用方：

- `apps/stage-tamagotchi/src/renderer/stores/mcp-tools.ts`
- 设置 MCP 页。

是否已接入聊天链路：是，注册到 LLM tools provider `mcp` 后可用。

是否已接入主动观察：否。

是否已接入 Life Tick：否。

是否已接入设置页：是。

是否有测试：

- `packages/stage-ui/src/tools/mcp.test.ts`
- `apps/stage-tamagotchi/src/renderer/stores/mcp-tools.test.ts`
- `apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.test.ts`
- `apps/stage-tamagotchi/src/renderer/pages/settings/modules/mcp-config.test.ts`

### 2.16 LLM Tools Registry

工具名：`useLlmToolsStore`

文件路径：`packages/stage-ui/src/stores/llm-tools.ts`

导出函数 / store 方法：

- `assignTools(provider, tools)`
- `registerTools(provider, tools)`
- `clearTools(provider)`
- `awaitPendingRegistrations()`

输入参数：

- provider id。
- Tool[] 或 Promise<Tool[]>。

输出结果：

- 汇总后的 `tools`。

副作用：

- 改变当前模型调用可见工具集合。

权限风险：

- 中。不是工具本身，但错误注册/重复注册会影响聊天可用工具。

当前调用方：

- 记忆工具、MCP、Agent、自我调节、主动观察屏幕工具。

是否已接入聊天链路：是。

是否已接入主动观察：间接。

是否已接入 Life Tick：否。

是否已接入设置页：否。

是否有测试：未见独立 `llm-tools.test.ts`，但多个工具测试间接覆盖。

## 3. 可以注册进 Tool Registry 的候选工具

以下是建议的 Tool Planning Mind 候选定义。`status` 是本报告额外加的实现状态标注。

```ts
type LumiToolDefinitionCandidate = {
  id: string
  name: string
  description: string
  capabilities: string[]
  inputHint: string
  outputHint: string
  riskLevel: 'low' | 'medium' | 'high'
  currentImplementationPath: string
  suggestedUseCases: string[]
  status: 'missing' | 'partial' | 'implemented'
}
```

| id | name | capabilities | inputHint | outputHint | riskLevel | currentImplementationPath | status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `search_short_memory` | 搜索短期意识状态 | 读取 current_state、最近话题、未完成事项、续接点 | 当前用户问题/主题 | 精简 current_state 片段 | low | `packages/stage-ui/src/stores/lumi-current-state.ts` | partial |
| `search_long_memory` | 搜索长期记忆 | RAG/向量检索长期记忆 | query、topic_hints、limit | reliable memories + instruction | low | `packages/stage-ui/src/stores/lumi-memory-tools.ts` | implemented |
| `read_user_profile` | 读取相关用户画像 | 相关画像检索、轻量锚点 | messageText、limit | prompt context / entries | medium | `packages/stage-ui/src/stores/lumi-user-profile.ts` | partial |
| `propose_user_profile_update` | 用户画像更新候选 | 生成/应用画像候选，进入 pending/auto review | candidate[]、sourceKind | stored/pending/skipped | medium | `packages/stage-ui/src/stores/lumi-user-profile.ts` | partial |
| `search_lumi_self_projects` | 搜索 Lumi 自己的项目 | active/planned/paused/completed 项目查询 | query/status/limit | project summaries | low | `apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts` | partial |
| `get_lumi_self_todos` | 读取 Lumi 自己的 Todo | 当前项目、下一步、进度 | projectId/status | todo list / nextExecutableTodo | low | `apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts` | partial |
| `search_idea_pool` | 搜索 Idea Pool | idea 排序、选择、状态筛选 | query/status/score threshold | idea list | low | `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts` | partial |
| `search_lumiworld_manifest` | 搜索 LumiWorld Manifest | LumiWorld 文件索引/manifest | query/path | matching manifest entries | low | 未发现统一 manifest store | missing |
| `read_lumiworld_file` | 读取 LumiWorld 文件 | 受限读取 LumiWorld 内文件 | relativePath | file content/metadata | medium | Life Tick 有 path 校验，未见通用读取工具 | missing |
| `search_diary` | 搜索日记 | 日记关键词/向量检索 | query/date range | diary snippets | low | 外置日记插件 + scheduler，未见统一 store | partial |
| `search_private_notes` | 搜索私密笔记 | 主动视觉 privateNotes 检索 | query/limit | notes | low | `lumi-proactive-vision.ts` | partial |
| `get_recent_life_events` | 最近 Life Tick 事件 | recentLogs、lastDecision、restState | limit | life log list | low | `lumi-autonomous-life.ts` | partial |
| `get_autonomous_decision_log` | 自主决策日志 | 主动视觉 decisionLog/runtimeLogs | limit/filter | decision log list | low | `lumi-proactive-vision.ts` | partial |
| `prepare_claude_sandbox_task` | 准备 Claude 沙箱任务 | 路由、权限检查、prompt 构造 | userRequest、targetPath | task route/prompt | high | `packages/stage-ui/src/libs/lumi-agent/index.ts` | partial |
| `run_claude_sandbox_task` | 执行 Claude 沙箱任务 | 启动/继续 Claude Code | task payload | status/taskId/log/files | high | `packages/stage-ui/src/stores/lumi-agent.ts` | implemented |
| `observe_screen` | 观察当前屏幕 | 截屏、视觉理解、环境上下文 | reason/source/options | observation text/status | high | `lumi-proactive-vision.ts` | implemented |
| `read_settings` | 读取 Lumi 相关设置 | 读取主动视觉、Life Tick、Agent、TTS 等设置 | keys | setting snapshot | low | 多个 store 分散实现 | partial |
| `adjust_low_risk_settings` | 低风险设置调整 | 调整主动观察、模型、思考、音量、上下文数量 | action、payload、reason | success/rejected + notice | medium | `lumi-self-adjustment.ts`、`lumi-proactive-vision.ts` | implemented |
| `write_private_note` | 写私密笔记 | 记录内部笔记，不显示为普通聊天 | content/source | note id | low | `lumi-proactive-vision.ts` | partial |
| `write_daily_diary` | 触发日记写入 | 手动/定时/自治写今日笔记 | trigger | status/system notice | medium | `lumi-diary-scheduler.ts` | partial |
| `advance_self_project_step` | 推进一个自我项目步骤 | 按 next todo 推进一步，可选 Claude | useClaude/force | acted/changedTodoIds | high | `lumi-autonomous-life.ts` | partial |

第一批最适合注册的工具：

1. `search_short_memory`
2. `search_long_memory`
3. `read_user_profile`
4. `search_lumi_self_projects`
5. `get_lumi_self_todos`
6. `search_idea_pool`
7. `get_recent_life_events`
8. `get_autonomous_decision_log`
9. `observe_screen`
10. `adjust_low_risk_settings`

其中已经是 LLM tool 的只有 `lumi_memory_search`、`lumi_delegate_to_claude_code`、`lumi_adjust_own_settings`、主动观察屏幕工具、MCP tools。多数候选目前是 store 方法，不是统一 tool。

## 4. 当前链路图

### 普通聊天链路

```text
用户消息 / 浮窗消息 / 语音识别文本
→ chat-sync.requestIngest()
→ 如果有图片附件：
   Lumi Eyes analyzeAttachmentsForChat()
   → 视觉模型生成图片理解 contextText
→ 如果用户文本要求“看屏幕”：
   proactiveVision.observeScreenForChatTool()
   → 截图/视觉理解
   → screenObservationContext
→ chatOrchestrator.ingest()
→ createLumiContext()
   → Persona anchor
   → Emotion state
   → userProfileStore.buildRelevantContext()
   → currentStateStore.buildPromptContext()
→ LLM stream
   → 可调用 tools:
      - lumi_memory_search
      - lumi_delegate_to_claude_code
      - lumi_adjust_own_settings
      - MCP tools
      - observe screen tool
→ 助手回复入库 / 字幕 / TTS
→ 聊天后处理:
   → 记忆候选写入
   → 用户画像候选提取和自动审阅
   → current_state 每 N 轮更新
   → 情绪状态更新
```

Tool Planning Mind 可插入点：

- `chat-sync.executeIngest()` 组装 `providerUserContext` 前。
- `createLumiContext()` 里，在画像/current_state 后增加“可用工具计划上下文”。
- LLM tools registry 前，基于 active persona 动态暴露工具。
- 聊天后处理前，统一把“工具结果”转入记忆/画像/current_state 证据。

### 主动视觉链路

```text
App 启动 / 设置页启动 proactiveVision.start()
→ scheduleNextTick()
→ runTick()
→ captureScreenImageDataUrl()
→ understandScreen()
→ createEnvironmentEntry()
→ buildAutonomousDecisionInput()
   → observation
   → recent chat state
   → user profile context
   → current_state context
   → self todo / life status
   → agent/sandbox permission
   → budget/settings
→ decideAfterObservation()
   → buildAutonomousDecisionPrompt()
   → consciousness model JSON
   → parse + fallback + sanitize
→ executeAutonomousDecision()
   → say_message: chatSync.requestIngest(hidden proactive message)
   → write_private_note: privateNotes
   → write_daily_summary: diaryScheduler.writeToday('autonomous')
   → adjust_low_risk_setting: apply settings patch/system_notice
   → continue_self_project / generate_or_select_idea / reflect: autonomousLife.runLifeTick()
   → request_permission / observe_quietly / rest: log or ask user
→ recordDecisionLog()
```

Tool Planning Mind 可插入点：

- `buildAutonomousDecisionInput()`：把统一工具清单、工具预算、工具依赖加入输入。
- `decideAfterObservation()`：让模型先输出 plan，再由本地 planner 解析成工具序列。
- `executeAutonomousDecision()`：替换成通用 tool executor + policy guard。

### Life Tick 链路

```text
App 启动 autonomousLife.start()
→ scheduleNextTick()
→ runLifeTick()
→ buildDecisionInput()
→ decideLifeTick()
   → 有 active project + executable todo: continue_project
   → 无 active project: select_idea / generate_ideas / rest
→ continue_project:
   → selfTodoStore.getNextExecutableTodo()
   → startTodo()
   → runClaudeForCurrentTodo() 可选
   → completeTodo() 或 blockTodo()
   → recordLog()
→ select_idea:
   → convertIdeaToProject()
   → resumeProject()
→ generate_ideas:
   → generateCandidateIdeas()
→ completed/paused/abandoned:
   → reflectProject()
```

Tool Planning Mind 可插入点：

- `decideLifeTick()` 目前是规则函数，可升级为读取 Tool Registry 后选择工具。
- `advanceCurrentTodo()` 可从只会 Claude Code 扩展为多工具执行。
- `generateCandidateIdeas()` 可读取日记、LumiWorld manifest、长期记忆等工具。

### 日记链路

```text
定时器 / 设置页手动 / 主动视觉自治动作
→ diaryScheduler.writeToday(trigger)
→ collectTodayMessages()
→ buildDiaryIngestText()
→ chatSync.requestIngest(hidden/system-notice)
→ 日记外置插件或聊天 authority 写入 md
→ system_notice 显示状态
```

Tool Planning Mind 可插入点：

- 写日记前调用 `search_private_notes`、`get_recent_life_events`、`search_lumi_self_projects`。
- 写日记后把日记摘要作为画像/current_state 证据。
- 需要一个统一 `search_diary` 工具让聊天和 Life Tick 能回读日记。

### 用户画像链路

```text
聊天完成
→ shouldConsiderForProfile()
→ extractDeterministicCandidates(userText)
→ curateLumiUserProfileWithLlm()
→ applyCandidates()
   → stored / pending / skipped
→ runLumiUserProfilePendingAutoReview()
   → consolidatePendingUpdates()
   → auto review prompt
   → approvePendingAutomatically() / markPendingAutoReview()
→ buildRelevantContext()
→ createLumiContext() 注入相关画像

current_state 更新后:
→ buildProfileCandidatesFromState()
→ applyCandidates(sourceKind='current_state')
```

Tool Planning Mind 可插入点：

- 增加只读 `read_user_profile` tool。
- 增加受控 `propose_user_profile_update` tool，只能提交候选，不能直接覆盖 protected core。
- 把 Life Tick / 日记 / Claude 任务结果统一作为 evidence source。

## 5. 当前最大断点

问题：聊天链路没有统一读取 Self Todo / Idea Pool / Life Tick。

影响：用户问“你最近自己做了什么”“Lumi 小角落是什么”时，模型只能靠上下文、记忆或猜测，不能可靠查自我项目。

涉及文件：

- `packages/stage-ui/src/stores/chat.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts`

建议修复方向：注册只读工具 `search_lumi_self_projects`、`get_lumi_self_todos`、`get_recent_life_events`，并写入 Lumi tool guidance。

---

问题：LumiWorld 没有统一 manifest / index。

影响：Lumi 可能创建了文件，但聊天、Life Tick、日记、用户画像都缺乏统一索引；后续查询只能靠路径或文件系统扫描。

涉及文件：

- `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts`
- `apps/stage-tamagotchi/src/renderer/pages/settings/plugins/index.vue`

建议修复方向：新增 `lumi-world-manifest` store，记录 path、title、summary、visibility、createdBy、relatedProjectId、updatedAt，并提供搜索/读取工具。

---

问题：privateNotes 更像运行时笔记，没有成为可检索知识源。

影响：主动视觉写了私密笔记，但聊天、日记和 Life Tick 很难复用；容易变成日志孤岛。

涉及文件：

- `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts`

建议修复方向：将 privateNotes 分为 runtime log 与 semantic private note，并提供 `search_private_notes`。

---

问题：日记系统依赖外置插件/隐藏聊天链路，但缺少统一读接口。

影响：能写日记，但 Lumi “随时查看自己的日记”能力不稳定；Tool Planning Mind 无法把日记作为规划输入。

涉及文件：

- `apps/stage-tamagotchi/src/renderer/stores/lumi-diary-scheduler.ts`
- 外置 `lumi-diary` 插件目录（本次未深入扫描）

建议修复方向：定义 diary repository/tool：`write_diary_entry`、`search_diary`、`read_diary_by_date`。

---

问题：用户画像与 current_state/Life Tick 的证据流不完全统一。

影响：current_state 能生成画像候选；Life Tick / Self Todo / Claude 任务更多靠记忆或日志，未系统进入画像 evidence。

涉及文件：

- `packages/stage-ui/src/stores/lumi-current-state.ts`
- `packages/stage-ui/src/stores/lumi-user-profile.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts`
- `packages/stage-ui/src/stores/lumi-agent.ts`

建议修复方向：增加统一 evidence adapter，把 Life Tick、项目反思、日记摘要、Claude 任务结果转换为候选证据，但仍走 `applyCandidates()`。

---

问题：MCP 工具已经能注册给聊天，但不属于 Lumi 自治工具规划。

影响：Lumi 普通聊天可用浏览器 MCP；Life Tick 和主动视觉不能直接把 MCP 作为内部行动工具。

涉及文件：

- `packages/stage-ui/src/tools/mcp.ts`
- `apps/stage-tamagotchi/src/renderer/stores/mcp-tools.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts`

建议修复方向：Tool Registry 按 risk/scope 抽象 MCP 能力，自治只能调用低风险、只读或用户授权工具。

---

问题：自我调节存在两条路径。

影响：聊天通过 `lumi_adjust_own_settings` 调整；主动视觉内部也可 `applyAutonomousSettingsPatch()`。规则重复，未来容易不一致。

涉及文件：

- `apps/stage-tamagotchi/src/renderer/stores/lumi-self-adjustment.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts`
- `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-autonomy.ts`

建议修复方向：把自调节统一成一个 policy + executor，主动视觉只提交调整请求。

---

问题：Claude Code 任务记忆已写入长期记忆，但继续任务仍依赖模型正确传 `continueFromTaskName` / `continueFromTaskId`。

影响：用户按自然名称说“继续那个任务”时，如果没有先检索任务记忆/任务列表，可能新开任务。

涉及文件：

- `packages/stage-ui/src/stores/lumi-agent.ts`
- `packages/stage-ui/src/libs/lumi-agent/index.ts`
- `apps/stage-tamagotchi/src/main/services/airi/claude-code-agent/index.ts`

建议修复方向：增加 `search_agent_tasks` 只读工具；`lumi_delegate_to_claude_code` 在 continue 请求缺少 id 时先本地检索候选。

---

问题：工具没有统一注册表。

影响：现在工具分散在 memory、agent、MCP、自调节、主动视觉中，Tool Planning Mind 无法统一读取“有什么工具、风险、输入输出、能否自治用”。

涉及文件：

- `packages/stage-ui/src/stores/llm-tools.ts`
- 所有 Lumi store。

建议修复方向：新增 `lumi-tool-registry.ts`，区分 LLM-callable、internal-only、autonomy-allowed、requires-confirmation。

## 6. 组合调用示例

### 用户问：“Lumi 小角落是什么？”

应该调用：

```text
1. useLumiCurrentStateStore().buildPromptContext()
2. useLumiSelfTodoStore().getActiveProjects()
3. useLumiAutonomousLifeStore().recentLogs / ideas / reflections
4. search_lumiworld_manifest（当前 missing）
5. read_lumiworld_file（当前 missing，必须限制在 LumiWorld）
6. 必要时 lumi_memory_search(query='Lumi 小角落')
```

当前能做的部分：

- `getActiveProjects()`、`recentLogs`、`lumi_memory_search`。
- LumiWorld 文件检索缺统一实现。

### 用户问：“你最近自己做了什么？”

应该调用：

```text
1. useLumiAutonomousLifeStore().recentLogs
2. useLumiSelfTodoStore().getActiveProjects()
3. useLumiSelfTodoStore().getProjectProgress(projectId)
4. useLumiAutonomousLifeStore().reflections
5. search_diary(query='最近自己做了什么')（当前 partial/missing）
```

当前断点：

- 这些能力不是聊天工具，模型默认看不到。

### 用户说：“继续之前那个番茄钟任务”

应该调用：

```text
1. lumi_memory_search(query='番茄钟 Claude Code 任务 task id')
2. search_agent_tasks(query='番茄钟')（当前 missing）
3. lumi_delegate_to_claude_code({
     userRequest: '继续/修改番茄钟任务...',
     continueFromTaskName: '番茄钟',
   })
4. Claude task window 显示进度
```

当前能做的部分：

- `lumi_delegate_to_claude_code` 支持 `continueFromTaskName` / `continueFromTaskId`。
- 缺少任务检索工具，依赖模型记住任务名。

### 用户问：“你为什么刚才不说话？”

应该调用：

```text
1. get_autonomous_decision_log(limit=5)
2. get_recent_life_events(limit=5)
3. useLumiProactiveVisionStore().runtimeLogs / decisionLog
4. useLumiAutonomousLifeStore().restState
```

当前断点：

- 决策日志只在设置页可见，不是聊天工具。

### 用户说：“你看一下我现在屏幕，在做什么？”

应该调用：

```text
1. proactiveVision.observeScreenForChatTool(reason)
2. Lumi Eyes/视觉模块理解屏幕
3. chat-sync 把 screenObservationContext 放进 providerUserContext
4. 意识模型回答
```

当前状态：

- 已实现，并在 `chat-sync.ts` 中对显式看屏幕请求做桥接。

### 用户说：“最近我是不是总在折腾 MCP？”

应该调用：

```text
1. lumi_memory_search(query='用户最近是否在折腾 MCP')
2. useLumiCurrentStateStore().buildPromptContext()
3. useLumiUserProfileStore().buildRelevantContext({ messageText: 'MCP' })
4. search_diary(query='MCP')（当前 partial/missing）
```

当前断点：

- 长期记忆和 current_state 可用；日记检索缺统一工具。

## 7. 测试现状

| 测试文件路径 | 覆盖内容 | 还缺哪些测试 |
| --- | --- | --- |
| `packages/stage-ui/src/stores/lumi-memory.test.ts` | 长期记忆 store、候选/检索等 | Tool Registry 场景、Life Tick 读记忆 |
| `packages/stage-ui/src/stores/lumi-memory-tools.test.ts` | `lumi_memory_search` guard 和返回逻辑 | 与 Tool Planning Mind 的组合调用 |
| `packages/stage-ui/src/stores/lumi-user-profile.test.ts` | 用户画像、Bootstrap、pending、auto review、prompt context | 来自 Life Tick/日记/Claude 任务的 evidence |
| `packages/stage-ui/src/stores/lumi-eyes.test.ts` | 聊天图片识别上下文 | 主动视觉屏幕链路不在此覆盖 |
| `packages/stage-ui/src/stores/lumi-emotion.test.ts` | 情绪状态和关系门控 | Life Tick 对情绪影响 |
| `packages/stage-ui/src/stores/chat/context-providers/lumi.test.ts` | Lumi prompt 注入、人格/记忆规则/current_state 部分 | Tool Planning Mind 注入位置 |
| `packages/stage-ui/src/tools/mcp.test.ts` | MCP runtime tools、直接工具名、browser snapshot follow-up | 多工具连续任务完成策略 |
| `packages/stage-ui/src/libs/lumi-agent/index.test.ts` | Agent 路由、权限模式、Claude prompt | 任务继续检索、任务命名记忆 |
| `apps/stage-tamagotchi/src/renderer/stores/mcp-tools.test.ts` | Electron MCP 工具注册 | MCP 灯状态和聊天工具唯一性端到端 |
| `apps/stage-tamagotchi/src/main/services/airi/mcp-servers/index.test.ts` | MCP server 管理 | Playwright MCP 实际连接端到端 |
| `apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.test.ts` | Self TodoList、依赖、完成校验、持久化 | Tool Registry 只读查询 |
| `apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-autonomy.test.ts` | 自主决策 fallback/sanitize/模式 | 自由工具规划、多工具序列执行 |
| `apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.test.ts` | Life Tick、Idea、Todo、Claude 当前步骤、持久化 | 日记/记忆/画像输入、MCP 工具输入 |
| `apps/stage-tamagotchi/src/renderer/stores/chat-sync.test.ts` | 聊天同步、ingest、图片桥接等 | Tool Planning Mind 选择工具后的端到端 |
| `apps/stage-tamagotchi/src/renderer/stores/chat-sync-lifecycle.test.ts` | chat-sync 生命周期 | 多窗口工具状态同步 |
| `apps/stage-tamagotchi/src/main/services/airi/claude-code-agent/index.test.ts` | Claude Code agent 主进程服务 | 失败日志归因、继续任务稳定性 |

明显缺失：

- `lumi-proactive-vision.ts` 的独立端到端测试。
- `lumi-diary-scheduler.ts` 的独立测试。
- `lumi-self-adjustment.ts` 的独立测试。
- LumiWorld manifest / diary search / private note search 相关测试。
- Tool Registry / Tool Planning Mind 目前还没有测试对象。

## 8. 结论

### 8.1 现在 Lumi 已经有哪些可用工具

已经实际作为 LLM tool 注册或可注册的能力：

- `lumi_memory_search`
- `lumi_delegate_to_claude_code`
- `lumi_adjust_own_settings`
- 主动观察屏幕工具（由 `useLumiProactiveVisionStore().registerObserveScreenTool()` 注册）
- MCP runtime tools，包括 Playwright MCP 这类外部工具

已经作为内部 store 可用，但不是聊天工具的能力：

- 用户画像读取/更新/自动审阅
- current_state 读取/更新
- Self TodoList 项目/Todo/进度管理
- Idea Pool / Life Tick / Reflection / RestState
- 主动视觉 privateNotes / decisionLog / runtimeLogs
- 日记 scheduler
- LumiWorld root 和权限边界配置

### 8.2 最适合第一批注册到 Tool Registry 的工具

优先注册只读、低风险、能显著减少幻觉的工具：

1. `search_short_memory`
2. `read_user_profile`
3. `search_lumi_self_projects`
4. `get_lumi_self_todos`
5. `search_idea_pool`
6. `get_recent_life_events`
7. `get_autonomous_decision_log`
8. `search_private_notes`
9. `search_diary`
10. `search_agent_tasks`

已有 LLM tools 应该也纳入统一 registry：

- `lumi_memory_search`
- `lumi_delegate_to_claude_code`
- `lumi_adjust_own_settings`
- `observe_screen`
- MCP tools

### 8.3 哪些工具缺统一接口

- Self TodoList：有 store 方法，无 LLM/read-only tool。
- Idea Pool / Life Tick：有 store 方法和设置 UI，无聊天查询 tool。
- Decision Log / Private Notes：有 store 状态，无搜索 tool。
- 日记：有 scheduler，缺统一 diary repository/search/read tool。
- LumiWorld：有 root/path 校验和设置，缺 manifest/search/read 工具。
- Agent Task：有 run/continue/list bridge，缺聊天侧安全任务检索 tool。
- 设置读取：设置分散在多个 store，缺统一 `read_settings`。

### 8.4 哪些工具存在但没有接入聊天

- `useLumiSelfTodoStore`
- `useLumiAutonomousLifeStore`
- `useLumiProactiveVisionStore().decisionLog/privateNotes/runtimeLogs` 的查询部分
- `useLumiDiarySchedulerStore` 的直接读写查询能力
- `useLumiCurrentStateStore` 的只读 tool
- `useLumiUserProfileStore` 的只读/候选更新 tool

### 8.5 下一步最应该先修哪 3 件事

1. 建立 `lumi-tool-registry.ts`：统一描述工具 id、输入输出、风险、是否聊天可用、是否自治可用、权限需求、实现路径。

2. 先注册只读查询工具：Self Todo、Idea Pool、Life Tick、Decision Log、User Profile、Current State、Agent Task History。这样 Lumi 回答“自己最近做了什么/为什么这么做/继续哪个任务”时不再靠猜。

3. 建立 LumiWorld Manifest + Diary Search：把 Lumi 自己创建的文件、日记、私密笔记从孤岛变成可检索资产，再让 Tool Planning Mind 能组合它们。

