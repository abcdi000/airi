import type { Locale } from '@intlify/core'
import type {
  LumiAccessRevokedPushed,
  LumiConversationListResponse,
  LumiConversationMessagesPushed,
  LumiConversationReplayRequest,
  LumiConversationReplayResponse,
  LumiGenerationPushed,
  LumiOnlineCapabilities,
  LumiOnlineDevice,
  LumiOnlinePerson,
  LumiPresencePushed,
  LumiSendMessageRequest,
  LumiSendMessageResponse,
} from '@proj-airi/lumi-online'
import type { ServerOptions } from '@proj-airi/server-runtime/server'
import type {
  ShortcutBinding,
  ShortcutRegistrationResult,
} from '@proj-airi/stage-shared/global-shortcut'
import type {
  StageViewErrorPayload,
  StageViewPatch,
  StageViewRequestAckPayload,
  StageViewSnapshotPayload,
} from '@proj-airi/stage-shared/godot-stage'
import type { LumiChannelDeviceQrPayload, LumiChannelDeviceScope, LumiChannelToolScope, ServerChannelQrPayload } from '@proj-airi/stage-shared/server-channel-qr'
import type {
  ThreeHitTestReadTracePayload,
  ThreeSceneRenderInfoTracePayload,
  VrmDisposeEndTracePayload,
  VrmDisposeStartTracePayload,
  VrmLoadEndTracePayload,
  VrmLoadErrorTracePayload,
  VrmLoadStartTracePayload,
  VrmUpdateFrameTracePayload,
} from '@proj-airi/stage-ui-three/trace'
import type { Rectangle } from 'electron'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

export const electronStartTrackMousePosition = defineInvokeEventa('eventa:invoke:electron:start-tracking-mouse-position')
export const electronStartDraggingWindow = defineInvokeEventa('eventa:invoke:electron:start-dragging-window')

export const electronOpenMainDevtools = defineInvokeEventa('eventa:invoke:electron:windows:main:devtools:open')
export const electronCenterMainWindow = defineInvokeEventa<Rectangle>('eventa:invoke:electron:windows:main:center')
export const electronOpenSettings = defineInvokeEventa<void, { route?: string }>('eventa:invoke:electron:windows:settings:open')
export const electronSettingsNavigate = defineEventa<{ route: string }>('eventa:event:electron:windows:settings:navigate')
export const electronOpenChat = defineInvokeEventa('eventa:invoke:electron:windows:chat:open')
export const electronOpenMiniChat = defineInvokeEventa('eventa:invoke:electron:windows:mini-chat:open')
export const electronOpenMinecraftMcpMonitor = defineInvokeEventa('eventa:invoke:electron:windows:minecraft-mcp-monitor:open')
export const electronOpenSettingsDevtools = defineInvokeEventa('eventa:invoke:electron:windows:settings:devtools:open')
export const electronOpenDevtoolsWindow = defineInvokeEventa<void, { key: string, route?: string, width?: number, height?: number, x?: number, y?: number }>('eventa:invoke:electron:windows:devtools:open')

export interface ElectronLumiOnlineState {
  status: 'offline' | 'connecting' | 'online' | 'reconnecting' | 'error'
  runtimeMode?: 'offline-client' | 'online-client'
  serverUrl?: string
  person?: LumiOnlinePerson
  capabilities?: LumiOnlineCapabilities
  error?: string
}

export const electronLumiOnlineGetState = defineInvokeEventa<ElectronLumiOnlineState>('eventa:invoke:electron:lumi-online:state')
export const electronLumiOnlineLogin = defineInvokeEventa<ElectronLumiOnlineState, { serverUrl: string, username: string, password: string, deviceId: string, deviceName: string }>('eventa:invoke:electron:lumi-online:login')
export const electronLumiOnlineClaimInvitation = defineInvokeEventa<ElectronLumiOnlineState, { serverUrl: string, invitationCode: string, username: string, password: string, deviceId: string, deviceName: string }>('eventa:invoke:electron:lumi-online:invitation:claim')
export const electronLumiOnlineConnectStored = defineInvokeEventa<ElectronLumiOnlineState, { deviceId: string, deviceName: string }>('eventa:invoke:electron:lumi-online:connect-stored')
export const electronLumiOnlineLogout = defineInvokeEventa<ElectronLumiOnlineState>('eventa:invoke:electron:lumi-online:logout')
export const electronLumiOnlineListConversations = defineInvokeEventa<LumiConversationListResponse>('eventa:invoke:electron:lumi-online:conversations')
export const electronLumiOnlineReplayConversation = defineInvokeEventa<LumiConversationReplayResponse, LumiConversationReplayRequest>('eventa:invoke:electron:lumi-online:replay')
export const electronLumiOnlineSendMessage = defineInvokeEventa<LumiSendMessageResponse, LumiSendMessageRequest>('eventa:invoke:electron:lumi-online:send')
export const electronLumiOnlineListDevices = defineInvokeEventa<{ devices: LumiOnlineDevice[] }>('eventa:invoke:electron:lumi-online:devices')
export const electronLumiOnlineRevokeDevice = defineInvokeEventa<{ device: LumiOnlineDevice }, { deviceId: string }>('eventa:invoke:electron:lumi-online:devices:revoke')
export const electronLumiOnlineTranscribeVoice = defineInvokeEventa<{ text: string }, { audio: Uint8Array, mimeType: string }>('eventa:invoke:electron:lumi-online:voice:transcribe')
export const electronLumiOnlineStateChanged = defineEventa<ElectronLumiOnlineState>('eventa:event:electron:lumi-online:state-changed')
export const electronLumiOnlineMessagesPushed = defineEventa<LumiConversationMessagesPushed>('eventa:event:electron:lumi-online:messages')
export const electronLumiOnlineGenerationPushed = defineEventa<LumiGenerationPushed>('eventa:event:electron:lumi-online:generation')
export const electronLumiOnlinePresencePushed = defineEventa<LumiPresencePushed>('eventa:event:electron:lumi-online:presence')
export const electronLumiOnlineAccessRevoked = defineEventa<LumiAccessRevokedPushed>('eventa:event:electron:lumi-online:access-revoked')

export interface ElectronLumiAstrBotIdentityBinding {
  platformInstanceId: string
  externalUserId: string
  personId: string
}

export interface ElectronLumiAstrBotGatewayConfig {
  enabled: boolean
  port: number
  apiToken: string
  identityBindings: ElectronLumiAstrBotIdentityBinding[]
}

export interface ElectronLumiAstrBotGatewayState {
  config: ElectronLumiAstrBotGatewayConfig
  running: boolean
  endpoint: string
  runtimeMode: 'offline-client' | 'online-client'
  lastError?: string
}

export const electronLumiAstrBotGatewayGetState = defineInvokeEventa<ElectronLumiAstrBotGatewayState>('eventa:invoke:electron:lumi-astrbot-gateway:state')
export const electronLumiAstrBotGatewayUpdateConfig = defineInvokeEventa<ElectronLumiAstrBotGatewayState, ElectronLumiAstrBotGatewayConfig>('eventa:invoke:electron:lumi-astrbot-gateway:config:update')
export const electronLumiAstrBotGatewayRotateToken = defineInvokeEventa<ElectronLumiAstrBotGatewayState>('eventa:invoke:electron:lumi-astrbot-gateway:token:rotate')

export interface ElectronWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export const electronWindowAnimateBounds = defineInvokeEventa<void, [ElectronWindowBounds, number?]>('eventa:invoke:electron:window:animate-bounds')
export const electronWindowStopBoundsAnimation = defineInvokeEventa<void>('eventa:invoke:electron:window:stop-bounds-animation')

export interface ElectronServerChannelConfig {
  tlsConfig?: ServerOptions['tlsConfig'] | null
  authToken: string
  hostname: string
}
export const electronGetServerChannelConfig = defineInvokeEventa<ElectronServerChannelConfig>('eventa:invoke:electron:server-channel:get-config')
export const electronApplyServerChannelConfig = defineInvokeEventa<ElectronServerChannelConfig, Partial<ElectronServerChannelConfig>>('eventa:invoke:electron:server-channel:apply-config')
export const electronGetServerChannelQrPayload = defineInvokeEventa<ServerChannelQrPayload>('eventa:invoke:electron:server-channel:get-qr-payload')

export interface ElectronLumiChannelDevice {
  id: string
  name: string
  userId: string
  conversationId: string
  roomTitle: string
  scopes: LumiChannelDeviceScope[]
  createdAt: string
  revokedAt: string | null
}
export interface ElectronLumiChannelDeviceList {
  hostInstanceId: string
  devices: ElectronLumiChannelDevice[]
}
export interface ElectronLumiChannelDeviceCredential {
  hostInstanceId: string
  device: ElectronLumiChannelDevice
  /** Plaintext credential shown once immediately after creation. */
  token: string
  /** Complete one-device connection payload suitable for QR transfer. */
  pairing: LumiChannelDeviceQrPayload
}
export interface ElectronLumiChannelDeviceArchiveRecord extends ElectronLumiChannelDevice {
  tokenHash: string
}
export interface ElectronLumiChannelDeviceArchiveSnapshot {
  version: 3
  hostInstanceId: string
  devices: ElectronLumiChannelDeviceArchiveRecord[]
  audit: ElectronLumiChannelAuditEntry[]
}
export interface ElectronLumiChannelDeviceArchiveSnapshotV2 {
  version: 2
  hostInstanceId: string
  devices: Array<Omit<ElectronLumiChannelDeviceArchiveRecord, 'scopes'> & { scopes: string[] }>
  audit: ElectronLumiChannelAuditEntry[]
}
export type ElectronLumiChannelAuditKind
  = | 'device-created'
    | 'device-revoked'
    | 'authenticated'
    | 'authentication-failed'
    | 'disconnected'
    | 'event-accepted'
    | 'event-rejected'
    | 'tool-resource-started'
    | 'tool-resource-finished'
    | 'tool-resource-terminated'
export interface ElectronLumiChannelAuditEntry {
  id: string
  createdAt: string
  kind: ElectronLumiChannelAuditKind
  deviceId?: string
  deviceName?: string
  userId?: string
  conversationId?: string
  eventType?: string
  code?: string
  reason?: string
  retryAfterMs?: number
  remoteAddress?: string
}
export interface ElectronLumiChannelAuditSnapshot {
  entries: ElectronLumiChannelAuditEntry[]
}
export const electronListLumiChannelDevices = defineInvokeEventa<ElectronLumiChannelDeviceList>('eventa:invoke:electron:server-channel:devices:list')
export const electronCreateLumiChannelDevice = defineInvokeEventa<ElectronLumiChannelDeviceCredential, { name: string, userId: string, conversationId: string, roomTitle: string, toolScopes?: LumiChannelToolScope[] }>('eventa:invoke:electron:server-channel:devices:create')
export const electronRevokeLumiChannelDevice = defineInvokeEventa<ElectronLumiChannelDevice, { deviceId: string }>('eventa:invoke:electron:server-channel:devices:revoke')
export const electronListLumiChannelAudit = defineInvokeEventa<ElectronLumiChannelAuditSnapshot>('eventa:invoke:electron:server-channel:devices:audit:list')
export const electronClearLumiChannelAudit = defineInvokeEventa<void>('eventa:invoke:electron:server-channel:devices:audit:clear')
export const electronExportLumiChannelDeviceArchive = defineInvokeEventa<ElectronLumiChannelDeviceArchiveSnapshot>('eventa:invoke:electron:server-channel:devices:archive:export')
export const electronImportLumiChannelDeviceArchive = defineInvokeEventa<ElectronLumiChannelDeviceArchiveSnapshot, ElectronLumiChannelDeviceArchiveSnapshot | ElectronLumiChannelDeviceArchiveSnapshotV2>('eventa:invoke:electron:server-channel:devices:archive:import')
export const electronClearLumiChannelDevices = defineInvokeEventa<void>('eventa:invoke:electron:server-channel:devices:clear')

export type ElectronUpdaterChannel = 'latest' | 'stable' | 'alpha' | 'beta' | 'nightly' | 'canary'

export interface ElectronUpdaterPreferences {
  channel?: ElectronUpdaterChannel
}

export const electronGetUpdaterPreferences = defineInvokeEventa<ElectronUpdaterPreferences>('eventa:invoke:electron:auto-updater:get-preferences')
export const electronSetUpdaterPreferences = defineInvokeEventa<ElectronUpdaterPreferences, ElectronUpdaterPreferences>('eventa:invoke:electron:auto-updater:set-preferences')

export * from './plugin/assets'
export * from './plugin/capabilities'
export * from './plugin/host'
export * from './plugin/tools'

export interface DesktopOverlayReadiness {
  state: 'booting' | 'ready' | 'degraded'
  error?: string
}

export const getDesktopOverlayReadinessContract = defineInvokeEventa<DesktopOverlayReadiness>('eventa:invoke:electron:windows:desktop-overlay:get-readiness')

export const captionIsFollowingWindowChanged = defineEventa<boolean>('eventa:event:electron:windows:caption-overlay:is-following-window-changed')
export const captionGetIsFollowingWindow = defineInvokeEventa<boolean>('eventa:invoke:electron:windows:caption-overlay:get-is-following-window')

export type RequestWindowActionDefault = 'confirm' | 'cancel' | 'close'
export interface RequestWindowPayload {
  id?: string
  route: string
  type?: string
  payload?: Record<string, any>
}
export interface RequestWindowPending {
  id: string
  type?: string
  payload?: Record<string, any>
}

// Reference window helpers are generic; callers can alias for clarity
export type NoticeAction = 'confirm' | 'cancel' | 'close'

export function createRequestWindowEventa(namespace: string) {
  const prefix = (name: string) => `eventa:${name}:electron:windows:${namespace}`
  return {
    openWindow: defineInvokeEventa<boolean, RequestWindowPayload>(prefix('invoke:open')),
    windowAction: defineInvokeEventa<void, { id: string, action: RequestWindowActionDefault }>(prefix('invoke:action')),
    pageMounted: defineInvokeEventa<RequestWindowPending | undefined, { id?: string }>(prefix('invoke:page-mounted')),
    pageUnmounted: defineInvokeEventa<void, { id?: string }>(prefix('invoke:page-unmounted')),
  }
}

// Notice window events built from generic factory
export const noticeWindowEventa = createRequestWindowEventa('notice')

// Widgets / Adhoc window events
export interface WidgetWindowSize {
  width?: number
  height?: number
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
}

export type WidgetGridSize = 's' | 'm' | 'l' | { cols?: number, rows?: number }

export interface WidgetsAddPayload {
  id?: string
  componentName: string
  componentProps?: Record<string, any>
  // size presets or explicit spans; renderer decides mapping
  size?: WidgetGridSize
  windowSize?: WidgetWindowSize | Record<string, unknown>
  // auto-dismiss in ms; if omitted, persistent until closed by user
  ttlMs?: number
}

export interface WidgetsUpdatePayload {
  id: string
  componentProps?: Record<string, any>
  size?: WidgetGridSize
  windowSize?: WidgetWindowSize | Record<string, unknown>
  ttlMs?: number
}

export interface WidgetSnapshot {
  id: string
  componentName: string
  componentProps: Record<string, any>
  size: WidgetGridSize
  windowSize?: WidgetWindowSize
  ttlMs: number
}

export interface PluginManifestSummary {
  name: string
  entrypoints: Record<string, string | undefined>
  path: string
  enabled: boolean
  loaded: boolean
  isNew: boolean
}

export interface PluginRegistrySnapshot {
  root: string
  plugins: PluginManifestSummary[]
}

// TODO: Replace these manually duplicated IPC types with re-exports from
// @proj-airi/plugin-sdk (CapabilityDescriptor) once stage-ui and the shared
// eventa layer can depend on the SDK without introducing unwanted coupling.
export interface PluginCapabilityPayload {
  key: string
  state: 'announced' | 'ready' | 'degraded' | 'withdrawn'
  metadata?: Record<string, unknown>
}

export interface PluginCapabilityState {
  key: string
  state: 'announced' | 'ready' | 'degraded' | 'withdrawn'
  metadata?: Record<string, unknown>
  updatedAt: number
}

export interface PluginHostSessionSummary {
  id: string
  manifestName: string
  phase: string
  runtime: 'electron' | 'node' | 'web'
  moduleId: string
}

export interface PluginHostDebugSnapshot {
  registry: PluginRegistrySnapshot
  sessions: PluginHostSessionSummary[]
  capabilities: PluginCapabilityState[]
  refreshedAt: number
}

export interface ElectronMcpStdioServerConfig {
  command?: string
  url?: string
  headers?: Record<string, string>
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  enabled?: boolean
  startupMode?: 'on_startup' | 'on_first_use' | 'manual'
  longRunning?: boolean
  persistent?: boolean
  requestTimeoutMs?: number
  maxTotalTimeoutMs?: number
}

export interface ElectronMcpStdioConfigFile {
  mcpServers: Record<string, ElectronMcpStdioServerConfig>
}

export interface ElectronMcpStdioApplyResult {
  path: string
  started: Array<{ name: string }>
  failed: Array<{ name: string, error: string }>
  skipped: Array<{ name: string, reason: string }>
}

export interface ElectronMcpStdioServerRuntimeStatus {
  name: string
  state: 'running' | 'stopped' | 'error'
  command: string
  args: string[]
  pid: number | null
  lastError?: string
  startupMode?: 'on_startup' | 'on_first_use' | 'manual'
  longRunning?: boolean
  persistent?: boolean
  requestTimeoutMs?: number
  maxTotalTimeoutMs?: number
}

export interface ElectronMcpStdioRuntimeStatus {
  path: string
  servers: ElectronMcpStdioServerRuntimeStatus[]
  updatedAt: number
}

export interface ElectronMcpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
  serverLongRunning?: boolean
  serverPersistent?: boolean
}

export interface ElectronMcpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
  debug?: Record<string, unknown>
}

export interface ElectronMcpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

export interface ElectronMcpStdioConfigText {
  path: string
  text: string
}

export interface ElectronMcpStdioTestResult {
  ok: boolean
  error?: string
  tools?: string[]
  durationMs: number
}

export interface ElectronMcpStdioTestPayload {
  name: string
  config: ElectronMcpStdioServerConfig
}

export interface ElectronMcpComputerUseChatTurn {
  sourceId: string
  turnId: string
}

export type ElectronMcpExclusiveResource = 'browser' | 'computer-use' | 'minecraft'

/** Content-free ownership metadata for one active exclusive MCP call. */
export interface ElectronMcpResourceLeaseInput {
  id: string
  resource: ElectronMcpExclusiveResource
  toolName: string
  serverName: string
  actorId: string
  conversationId: string
  deviceId?: string
}

/** Operator-visible state for one active exclusive MCP call. */
export interface ElectronMcpResourceLease extends ElectronMcpResourceLeaseInput {
  startedAt: string
  terminationRequestedAt: string | null
}

export const electronMcpOpenConfigFile = defineInvokeEventa<{ path: string }>('eventa:invoke:electron:mcp:open-config-file')
export const electronMcpApplyAndRestart = defineInvokeEventa<ElectronMcpStdioApplyResult>('eventa:invoke:electron:mcp:apply-and-restart')
export const electronMcpGetRuntimeStatus = defineInvokeEventa<ElectronMcpStdioRuntimeStatus>('eventa:invoke:electron:mcp:get-runtime-status')
export const electronMcpListTools = defineInvokeEventa<ElectronMcpToolDescriptor[]>('eventa:invoke:electron:mcp:list-tools')
export const electronMcpCallTool = defineInvokeEventa<ElectronMcpCallToolResult, ElectronMcpCallToolPayload>('eventa:invoke:electron:mcp:call-tool')
export const electronMcpInterruptComputerUse = defineInvokeEventa<{ interrupted: boolean }>('eventa:invoke:electron:mcp:interrupt-computer-use')
export const electronMcpSetComputerUseChatActive = defineInvokeEventa<void, { sourceId: string, active: boolean, reset?: boolean, turnId?: string }>('eventa:invoke:electron:mcp:set-computer-use-chat-active')
export const electronMcpGetComputerUseChatTurn = defineInvokeEventa<ElectronMcpComputerUseChatTurn | undefined>('eventa:invoke:electron:mcp:get-computer-use-chat-turn')
export const electronMcpListResourceLeases = defineInvokeEventa<ElectronMcpResourceLease[]>('eventa:invoke:electron:mcp:resource-leases:list')
export const electronMcpTerminateResourceLease = defineInvokeEventa<ElectronMcpResourceLease, { leaseId: string }>('eventa:invoke:electron:mcp:resource-leases:terminate')
export const electronMcpReadConfigText = defineInvokeEventa<ElectronMcpStdioConfigText>('eventa:invoke:electron:mcp:read-config-text')
export const electronMcpWriteConfigText = defineInvokeEventa<ElectronMcpStdioConfigText, { text: string }>('eventa:invoke:electron:mcp:write-config-text')
export const electronMcpTestServer = defineInvokeEventa<ElectronMcpStdioTestResult, ElectronMcpStdioTestPayload>('eventa:invoke:electron:mcp:test-server')

export const widgetsOpenWindow = defineInvokeEventa<void, { id?: string }>('eventa:invoke:electron:windows:widgets:open')
export const widgetsHideWindow = defineInvokeEventa<void, { id?: string }>('eventa:invoke:electron:windows:widgets:hide')
export const widgetsAdd = defineInvokeEventa<string | undefined, WidgetsAddPayload>('eventa:invoke:electron:windows:widgets:add')
export const widgetsRemove = defineInvokeEventa<void, { id: string }>('eventa:invoke:electron:windows:widgets:remove')
export const widgetsClear = defineInvokeEventa('eventa:invoke:electron:windows:widgets:clear')
export const widgetsUpdate = defineInvokeEventa<void, WidgetsUpdatePayload>('eventa:invoke:electron:windows:widgets:update')
export const widgetsFetch = defineInvokeEventa<WidgetSnapshot | void, { id: string }>('eventa:invoke:electron:windows:widgets:fetch')
export const widgetsPrepareWindow = defineInvokeEventa<string | undefined, { id?: string }>('eventa:invoke:electron:windows:widgets:prepare')
export const widgetsIframePublish = defineInvokeEventa<void, { id: string, event: Record<string, unknown> }>('eventa:invoke:electron:windows:widgets:iframe-publish')

export const electronWindowClose = defineInvokeEventa<void>('eventa:invoke:electron:window:close')
export type ElectronWindowLifecycleReason
  = | 'initial'
    | 'snapshot'
    | 'show'
    | 'hide'
    | 'minimize'
    | 'restore'
    | 'focus'
    | 'blur'

export interface ElectronWindowLifecycleState {
  focused: boolean
  minimized: boolean
  reason: ElectronWindowLifecycleReason
  updatedAt: number
  visible: boolean
}

export const electronWindowLifecycleChanged = defineEventa<ElectronWindowLifecycleState>('eventa:event:electron:window:lifecycle-changed')
export const electronGetWindowLifecycleState = defineInvokeEventa<ElectronWindowLifecycleState>('eventa:invoke:electron:window:get-lifecycle-state')
export const electronWindowSetAlwaysOnTop = defineInvokeEventa<void, boolean>('eventa:invoke:electron:window:set-always-on-top')
export const electronAppOpenUserDataFolder = defineInvokeEventa<{ path: string }>('eventa:invoke:electron:app:open-user-data-folder')
export const electronAppOpenPath = defineInvokeEventa<{ path: string }, { path: string }>('eventa:invoke:electron:app:open-path')
export const electronAppQuit = defineInvokeEventa<void>('eventa:invoke:electron:app:quit')

export interface ElectronLumiUserRecord {
  id: string
  displayName: string
  preferredAddress: string
  role: 'owner' | 'member' | 'guest'
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

export interface ElectronLumiExternalIdentityRecord {
  id: string
  userId: string
  provider: string
  providerInstanceId: string
  externalUserId: string
  createdAt: string
}

export interface ElectronLumiIdentitySnapshot {
  users: ElectronLumiUserRecord[]
  externalIdentities: ElectronLumiExternalIdentityRecord[]
  activeUserId: string
  migrationVersion: string
  dbPath?: string
}

export const electronLumiIdentityGetSnapshot = defineInvokeEventa<ElectronLumiIdentitySnapshot>('eventa:invoke:electron:lumi-identity:get-snapshot')
export const electronLumiIdentityCreateUser = defineInvokeEventa<ElectronLumiIdentitySnapshot, { displayName: string, preferredAddress?: string }>('eventa:invoke:electron:lumi-identity:create-user')
export const electronLumiIdentityUpdateUser = defineInvokeEventa<ElectronLumiIdentitySnapshot, { id: string, displayName?: string, preferredAddress?: string, status?: 'active' | 'inactive' }>('eventa:invoke:electron:lumi-identity:update-user')
export const electronLumiIdentitySetActiveUser = defineInvokeEventa<ElectronLumiIdentitySnapshot, { userId: string }>('eventa:invoke:electron:lumi-identity:set-active-user')
export const electronLumiIdentityLinkExternalIdentity = defineInvokeEventa<ElectronLumiIdentitySnapshot, { userId: string, provider: string, providerInstanceId: string, externalUserId: string }>('eventa:invoke:electron:lumi-identity:link-external-identity')
export const electronLumiIdentityReplaceSnapshot = defineInvokeEventa<ElectronLumiIdentitySnapshot, ElectronLumiIdentitySnapshot>('eventa:invoke:electron:lumi-identity:replace-snapshot')
export const electronLumiIdentityChanged = defineEventa<ElectronLumiIdentitySnapshot>('eventa:event:electron:lumi-identity:changed')
export const electronLumiIdentitySetRuntimeBusy = defineInvokeEventa<void, { busy: boolean }>('eventa:invoke:electron:lumi-identity:set-runtime-busy')

export interface ElectronLumiMemorySnapshot {
  fragments: Record<string, any>[]
  events: Record<string, any>[]
  seedId: string
  dbPath?: string
}

export interface ElectronLumiMemoryVectorRecord {
  memoryId: string
  model: string
  signature: string
  vector: number[]
  device?: string
  updatedAt: string
}

export interface ElectronLumiMemoryVectorStatus {
  available: boolean
  running: boolean
  model: string
  device: string
  phase?: string
  indexedCount: number
  totalCount: number
  missingCount: number
  downloadPercent?: number
  downloadedBytes?: number
  downloadTotalBytes?: number
  downloadSpeedBytesPerSecond?: number
  progress?: string
  lastError?: string
}

export interface ElectronLumiMemoryVectorSearchResult {
  scores: Record<string, number>
  status: ElectronLumiMemoryVectorStatus
}

export const electronLumiMemoryGetSnapshot = defineInvokeEventa<ElectronLumiMemorySnapshot, { userId: string }>('eventa:invoke:electron:lumi-memory:get-snapshot')
export const electronLumiMemoryReplaceSnapshot = defineInvokeEventa<ElectronLumiMemorySnapshot, { userId: string, snapshot: ElectronLumiMemorySnapshot }>('eventa:invoke:electron:lumi-memory:replace-snapshot')
export const electronLumiMemoryUpsertMemory = defineInvokeEventa<void, Record<string, any>>('eventa:invoke:electron:lumi-memory:upsert-memory')
export const electronLumiMemoryDeleteMemory = defineInvokeEventa<void, { id: string, userId: string }>('eventa:invoke:electron:lumi-memory:delete-memory')
export const electronLumiMemoryGetVectors = defineInvokeEventa<ElectronLumiMemoryVectorRecord[], { model: string, userId: string }>('eventa:invoke:electron:lumi-memory:get-vectors')
export const electronLumiMemoryUpsertVector = defineInvokeEventa<void, ElectronLumiMemoryVectorRecord>('eventa:invoke:electron:lumi-memory:upsert-vector')
export const electronLumiMemoryDeleteVector = defineInvokeEventa<void, { memoryId: string, model?: string }>('eventa:invoke:electron:lumi-memory:delete-vector')
export const electronLumiMemoryVectorStatus = defineInvokeEventa<ElectronLumiMemoryVectorStatus, { userId: string }>('eventa:invoke:electron:lumi-memory:vector-status')
export const electronLumiMemoryBackfillVectors = defineInvokeEventa<ElectronLumiMemoryVectorStatus, { userId: string, limit?: number }>('eventa:invoke:electron:lumi-memory:backfill-vectors')
export const electronLumiMemorySearchVectors = defineInvokeEventa<ElectronLumiMemoryVectorSearchResult, { userId: string, query: string, limit?: number }>('eventa:invoke:electron:lumi-memory:search-vectors')
export const electronLumiMemorySyncVector = defineInvokeEventa<ElectronLumiMemoryVectorStatus, Record<string, any>>('eventa:invoke:electron:lumi-memory:sync-vector')
export const electronLumiMemorySaveEvent = defineInvokeEventa<void, { userId: string, event: Record<string, any> }>('eventa:invoke:electron:lumi-memory:save-event')
export const electronLumiMemorySetSeedId = defineInvokeEventa<void, { userId: string, seedId: string }>('eventa:invoke:electron:lumi-memory:set-seed-id')
export const electronLumiMemoryClear = defineInvokeEventa<void, { userId: string }>('eventa:invoke:electron:lumi-memory:clear')

export interface ElectronLumiUserProfileSnapshot {
  entries: Record<string, any>[]
  pendingUpdates: Record<string, any>[]
  events: Record<string, any>[]
  autoUpdateEnabled: boolean
  bootstrapVersion: string
  dbPath?: string
  meta?: Record<string, any>
  canImportLegacyLocalData?: boolean
}

export const electronLumiUserProfileGetSnapshot = defineInvokeEventa<ElectronLumiUserProfileSnapshot, { userId: string }>('eventa:invoke:electron:lumi-user-profile:get-snapshot')
export const electronLumiUserProfileReplaceSnapshot = defineInvokeEventa<ElectronLumiUserProfileSnapshot, { userId: string, snapshot: ElectronLumiUserProfileSnapshot }>('eventa:invoke:electron:lumi-user-profile:replace-snapshot')
export const electronLumiUserProfileSaveEntry = defineInvokeEventa<void, { userId: string, entry: Record<string, any> }>('eventa:invoke:electron:lumi-user-profile:save-entry')
export const electronLumiUserProfileUpdateEntry = defineInvokeEventa<void, { userId: string, entry: Record<string, any> }>('eventa:invoke:electron:lumi-user-profile:update-entry')
export const electronLumiUserProfileArchiveEntry = defineInvokeEventa<void, { userId: string, id: string }>('eventa:invoke:electron:lumi-user-profile:archive-entry')
export const electronLumiUserProfileDeleteEntry = defineInvokeEventa<void, { userId: string, id: string }>('eventa:invoke:electron:lumi-user-profile:delete-entry')
export const electronLumiUserProfileSaveEvidence = defineInvokeEventa<void, { userId: string, entryId: string, evidence: Record<string, any> }>('eventa:invoke:electron:lumi-user-profile:save-evidence')
export const electronLumiUserProfileSaveHistory = defineInvokeEventa<void, { userId: string, entryId?: string, history?: Record<string, any>, event?: Record<string, any> }>('eventa:invoke:electron:lumi-user-profile:save-history')
export const electronLumiUserProfileSavePendingUpdate = defineInvokeEventa<void, { userId: string, pending: Record<string, any> }>('eventa:invoke:electron:lumi-user-profile:save-pending-update')
export const electronLumiUserProfileApprovePendingUpdate = defineInvokeEventa<void, { userId: string, id: string, entry?: Record<string, any> }>('eventa:invoke:electron:lumi-user-profile:approve-pending-update')
export const electronLumiUserProfileRejectPendingUpdate = defineInvokeEventa<void, { userId: string, id: string }>('eventa:invoke:electron:lumi-user-profile:reject-pending-update')
export const electronLumiUserProfileSetMeta = defineInvokeEventa<void, { userId: string, key: string, value: any }>('eventa:invoke:electron:lumi-user-profile:set-meta')
export const electronLumiUserProfileClear = defineInvokeEventa<void, { userId: string }>('eventa:invoke:electron:lumi-user-profile:clear')

export interface ElectronLumiCurrentStateSnapshot {
  state: Record<string, any> | null
  dbPath?: string
}

export const electronLumiCurrentStateGetSnapshot = defineInvokeEventa<ElectronLumiCurrentStateSnapshot, { userId: string }>('eventa:invoke:electron:lumi-current-state:get-snapshot')
export const electronLumiCurrentStateSaveSnapshot = defineInvokeEventa<ElectronLumiCurrentStateSnapshot, { userId: string, snapshot: ElectronLumiCurrentStateSnapshot }>('eventa:invoke:electron:lumi-current-state:save-snapshot')
export const electronLumiCurrentStateClear = defineInvokeEventa<void, { userId: string }>('eventa:invoke:electron:lumi-current-state:clear')

export interface ElectronClaudeCodeAgentRunPayload {
  userRequest: string
  taskType?: string
  permissionMode?: string
  targetName?: string
  condaEnv?: string
  settings?: Record<string, any>
  continueFromTaskId?: string
  continueFromTaskName?: string
  detached?: boolean
}

export interface ElectronClaudeCodeAgentResult {
  taskId: string
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'timeout'
  stdout: string
  stderr: string
  changedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
  startedAt: string
  endedAt: string
  exitCode?: number
  error?: string
  diagnostics?: Record<string, any>
  task?: Record<string, any>
  log?: Record<string, any>
}

export interface ElectronClaudeCodeAgentTaskEvent {
  id: string
  taskId: string
  type: 'created' | 'started' | 'stdout' | 'stderr' | 'permission_request' | 'permission_decision' | 'completed' | 'error'
  message: string
  createdAt: string
  data?: Record<string, any>
}

export interface ElectronClaudeCodeAgentTaskSnapshot {
  taskId?: string
  events: ElectronClaudeCodeAgentTaskEvent[]
  log?: Record<string, any>
  running: boolean
}

export const electronClaudeCodeAgentRunTask = defineInvokeEventa<ElectronClaudeCodeAgentResult, ElectronClaudeCodeAgentRunPayload>('eventa:invoke:electron:lumi-agent:claude-code:run-task')
export const electronClaudeCodeAgentCancelTask = defineInvokeEventa<void, { taskId: string }>('eventa:invoke:electron:lumi-agent:claude-code:cancel-task')
export const electronClaudeCodeAgentGetLog = defineInvokeEventa<Record<string, any> | undefined, { taskId: string, settings?: Record<string, any> }>('eventa:invoke:electron:lumi-agent:claude-code:get-log')
export const electronClaudeCodeAgentListLogs = defineInvokeEventa<Record<string, any>[], { limit?: number, settings?: Record<string, any> }>('eventa:invoke:electron:lumi-agent:claude-code:list-logs')
export const electronClaudeCodeAgentOpenTaskWindow = defineInvokeEventa<void, { taskId?: string, settings?: Record<string, any> }>('eventa:invoke:electron:lumi-agent:claude-code:open-task-window')
export const electronClaudeCodeAgentPickCommand = defineInvokeEventa<{ path?: string }>('eventa:invoke:electron:lumi-agent:claude-code:pick-command')
export const electronClaudeCodeAgentSearchCommand = defineInvokeEventa<{ path?: string, candidates: string[], error?: string }, { command?: string }>('eventa:invoke:electron:lumi-agent:claude-code:search-command')
export const electronClaudeCodeAgentGetTaskSnapshot = defineInvokeEventa<ElectronClaudeCodeAgentTaskSnapshot, { taskId?: string, settings?: Record<string, any> }>('eventa:invoke:electron:lumi-agent:claude-code:get-task-snapshot')
export const electronClaudeCodeAgentApproveTaskPermission = defineInvokeEventa<void, { taskId: string }>('eventa:invoke:electron:lumi-agent:claude-code:approve-permission')
export const electronClaudeCodeAgentRejectTaskPermission = defineInvokeEventa<void, { taskId: string }>('eventa:invoke:electron:lumi-agent:claude-code:reject-permission')

export type ElectronGodotStageState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

/**
 * Snapshot of the Godot sidecar lifecycle owned by Electron main.
 *
 * Use when:
 * - Renderer windows need to reflect whether the external Godot window is available
 * - Settings or stage pages need lifecycle feedback after start/stop actions
 *
 * Expects:
 * - `pid` is only set while the Godot child process exists
 * - `lastError` is present for the most recent lifecycle or scene-apply failure
 *
 * Returns:
 * - N/A
 */
export interface ElectronGodotStageStatus {
  state: ElectronGodotStageState
  pid: number | null
  lastError?: string
  updatedAt: number
}

/**
 * Serialized scene input payload forwarded from renderer to Electron main.
 *
 * Use when:
 * - The selected model should be materialized to disk and applied to the Godot scene
 *
 * Expects:
 * - `data` contains the full model file bytes
 * - `fileName` matches the original model asset name when available
 *
 * Returns:
 * - N/A
 */
export interface ElectronGodotStageSceneInputPayload {
  modelId: string
  format: 'vrm'
  name: string
  fileName: string
  data: Uint8Array
}

export const electronGodotStageStart = defineInvokeEventa<ElectronGodotStageStatus>('eventa:invoke:electron:godot-stage:start')
export const electronGodotStageStop = defineInvokeEventa<ElectronGodotStageStatus>('eventa:invoke:electron:godot-stage:stop')
export const electronGodotStageGetStatus = defineInvokeEventa<ElectronGodotStageStatus>('eventa:invoke:electron:godot-stage:get-status')
export const electronGodotStageApplySceneInput = defineInvokeEventa<void, ElectronGodotStageSceneInputPayload>('eventa:invoke:electron:godot-stage:apply-scene-input')
export const electronGodotStageGetViewSnapshot = defineInvokeEventa<StageViewSnapshotPayload | null>('eventa:invoke:electron:godot-stage:view-snapshot:get')
export const electronGodotStageApplyViewPatch = defineInvokeEventa<StageViewRequestAckPayload, StageViewPatch>('eventa:invoke:electron:godot-stage:view-state:apply-patch')
export const electronGodotStageRequestViewSnapshot = defineInvokeEventa<StageViewRequestAckPayload>('eventa:invoke:electron:godot-stage:view-state:request-snapshot')
export const electronGodotStageStatusChanged = defineEventa<ElectronGodotStageStatus>('eventa:event:electron:godot-stage:status-changed')
export const electronGodotStageViewSnapshotChanged = defineEventa<StageViewSnapshotPayload>('eventa:event:electron:godot-stage:view-snapshot-changed')
export const electronGodotStageViewStateError = defineEventa<StageViewErrorPayload>('eventa:event:electron:godot-stage:view-state-error')

// Global shortcut ->

/**
 * Phase of a shortcut trigger event.
 *
 * - `down` — key combination pressed
 * - `up`   — key combination released; only emitted by drivers that
 *            accepted a binding with `receiveKeyUps: true`
 */
export type ElectronShortcutTriggerPhase = 'down' | 'up'

/**
 * Payload broadcast to all subscribed windows when a registered shortcut
 * fires. Renderer composables filter by `id` to dispatch local handlers.
 */
export interface ElectronShortcutTriggerPayload {
  id: string
  phase: ElectronShortcutTriggerPhase
}

export const electronShortcutRegister = defineInvokeEventa<ShortcutRegistrationResult, ShortcutBinding>('eventa:invoke:electron:shortcut:register')
export const electronShortcutUnregister = defineInvokeEventa<void, { id: string }>('eventa:invoke:electron:shortcut:unregister')
export const electronShortcutUnregisterAll = defineInvokeEventa<void>('eventa:invoke:electron:shortcut:unregister-all')
export const electronShortcutList = defineInvokeEventa<ShortcutBinding[]>('eventa:invoke:electron:shortcut:list')
export const electronShortcutTriggered = defineEventa<ElectronShortcutTriggerPayload>('eventa:event:electron:shortcut:triggered')

// <- Global shortcut

export type StageThreeRuntimeTraceEnvelope
  = | { type: 'three-render-info', payload: ThreeSceneRenderInfoTracePayload }
    | { type: 'three-hit-test-read', payload: ThreeHitTestReadTracePayload }
    | { type: 'vrm-update-frame', payload: VrmUpdateFrameTracePayload }
    | { type: 'vrm-load-start', payload: VrmLoadStartTracePayload }
    | { type: 'vrm-load-end', payload: VrmLoadEndTracePayload }
    | { type: 'vrm-load-error', payload: VrmLoadErrorTracePayload }
    | { type: 'vrm-dispose-start', payload: VrmDisposeStartTracePayload }
    | { type: 'vrm-dispose-end', payload: VrmDisposeEndTracePayload }

export interface StageThreeRuntimeTraceForwardedPayload {
  envelope: StageThreeRuntimeTraceEnvelope
  origin: string
}

export interface StageThreeRuntimeTraceRemoteControlPayload {
  origin: string
}

export const stageThreeRuntimeTraceForwardedEvent = defineEventa<StageThreeRuntimeTraceForwardedPayload>('eventa:event:stage-three-runtime-trace:forwarded')
export const stageThreeRuntimeTraceRemoteEnableEvent = defineEventa<StageThreeRuntimeTraceRemoteControlPayload>('eventa:event:stage-three-runtime-trace:remote-enable')
export const stageThreeRuntimeTraceRemoteDisableEvent = defineEventa<StageThreeRuntimeTraceRemoteControlPayload>('eventa:event:stage-three-runtime-trace:remote-disable')

// Internal event from main -> widgets renderer when a widget should render
export const widgetsRenderEvent = defineEventa<WidgetSnapshot>('eventa:event:electron:windows:widgets:render')
export const widgetsRemoveEvent = defineEventa<{ id: string }>('eventa:event:electron:windows:widgets:remove')
export const widgetsClearEvent = defineEventa('eventa:event:electron:windows:widgets:clear')
export const widgetsUpdateEvent = defineEventa<WidgetsUpdatePayload>('eventa:event:electron:windows:widgets:update')

// Onboarding window events
export const electronOnboardingClose = defineInvokeEventa('eventa:invoke:electron:windows:onboarding:close')
export const electronOpenOnboarding = defineInvokeEventa('eventa:invoke:electron:windows:onboarding:open')
export const electronOnboardingOpenOnlineAccount = defineInvokeEventa('eventa:invoke:electron:windows:onboarding:open-online-account')

export interface ElectronLumiDiaryExportEntry {
  id: string
  entryDate: string
  title: string
  content: string
  sourceSummary: string
  createdAt: number
  updatedAt: number
}

export interface ElectronLumiDiaryExportSnapshot {
  diaryDir: string
  entries: ElectronLumiDiaryExportEntry[]
}

export const electronLumiDiaryExportAll = defineInvokeEventa<ElectronLumiDiaryExportSnapshot>('eventa:invoke:electron:lumi-diary:export-all')

// Auth — OIDC Authorization Code + PKCE flow via system browser
export interface ElectronAuthTokens {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresIn: number
}
export const electronAuthStartLogin = defineInvokeEventa<void>('eventa:invoke:electron:auth:start-login')
export const electronAuthCallback = defineEventa<ElectronAuthTokens>('eventa:event:electron:auth:callback')
export const electronAuthCallbackError = defineEventa<{ error: string }>('eventa:event:electron:auth:callback-error')
export const electronAuthLogout = defineInvokeEventa<void>('eventa:invoke:electron:auth:logout')

export const i18nSetLocale = defineInvokeEventa<void, Locale>('eventa:invoke:electron:i18n:set-locale')
export const i18nGetLocale = defineInvokeEventa<string | undefined>('eventa:invoke:electron:i18n:get-locale')

export { electron } from '@proj-airi/electron-eventa'
export * from '@proj-airi/electron-eventa/electron-updater'
