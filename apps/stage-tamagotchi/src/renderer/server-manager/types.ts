export type ManagerPageId = 'overview' | 'users' | 'modules' | 'consciousness' | 'transcription' | 'mcp' | 'plugins' | 'memory' | 'network' | 'data' | 'logs'

export interface ManagerState {
  processState: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  pid?: number
  error?: string
  configPath: string
  autoStart: boolean
  logs: string[]
  config: {
    publicBaseURL: string
    hostname: string
    port: number
    model: {
      providerId: string
      baseURL: string
      model: string
      apiKeySet: boolean
      temperature?: number
      maxOutputTokens?: number
      maxSteps: number
      thinkingMode: 'auto' | 'enabled' | 'disabled'
      reasoningEffort: 'auto' | 'high' | 'max'
      providerOptions: Record<string, unknown>
    }
    vector: { enabled: boolean, model: string, device: string }
    transcription: { providerId: string, enabled: boolean, baseURL: string, model: string, language?: string, prompt?: string, maxVoiceBytes: number, apiKeySet: boolean }
    tls: { enabled: boolean, certPath?: string, keyPath?: string }
    trustedOrigins: string[]
    mcp: { mcpServers?: Record<string, McpServerConfig> }
    plugins: { directory?: string, enabled: string[], settings: Record<string, Record<string, unknown>> }
    background: {
      diary?: { enabled?: boolean, dailyTime?: string }
      autonomousLife?: { enabled?: boolean, minimumIntervalMs?: number, maximumIntervalMs?: number }
    }
    astrbot: {
      enabled: boolean
      tokenConfigured: boolean
      identityBindings: Array<{
        platformInstanceId: string
        externalUserId: string
        personId: string
      }>
    }
  }
}

export interface ManagerOverview {
  people: number
  boundAccounts: number
  conversations: { direct: number, group: number }
  messages: number
  memories: Record<'candidate' | 'active' | 'rejected' | 'contradicted' | 'archived', number>
  personStates: number
  diaryEntries: number
  privateNotes: number
  jobs: Record<'pending' | 'running' | 'completed' | 'failed' | 'cancelled', number>
  devices: { active: number, revoked: number }
}

export interface ManagedUser { id: string, displayName: string, role: 'owner' | 'member', accountBound: boolean }
export interface ManagedDevice { id: string, accountId: string, name: string, platform: string, lastSeenAt: number, revokedAt?: number }
export interface ToolStatus {
  servers: Array<{ name: string, state: string, toolCount: number, lastError?: string }>
  activeResourceLeases: Array<{ id: string, resource: string, toolName: string, actorPersonId: string, conversationId: string, startedAt: number, terminationRequestedAt?: number }>
}
export interface VectorStatus { enabled?: boolean, model?: string, device?: string, indexedCount?: number, totalCount?: number, missingCount?: number }
export interface ProviderModel { id: string, ownedBy?: string }
export interface ProviderBalance { available: boolean, balances: Array<{ currency: string, total: string, granted: string, toppedUp: string }> }
export interface PluginInfo { name: string, path: string, enabled: boolean, serverCompatible: boolean, permissions: string[], error?: string }
export interface PluginStatus { name: string, state: 'disabled' | 'loaded' | 'error' | 'incompatible', toolCount: number, path: string, lastError?: string }

export interface McpServerConfig {
  command?: string
  url?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  cwd?: string
  enabled?: boolean
  startupMode?: 'on_startup' | 'on_first_use' | 'manual'
  requestTimeoutMs?: number
  maxTotalTimeoutMs?: number
  longRunning?: boolean
  persistent?: boolean
}

export interface McpServerDraft {
  id: string
  name: string
  command: string
  url: string
  argsText: string
  envText: string
  headersText: string
  cwd: string
  enabled: boolean
  startupMode: 'on_startup' | 'on_first_use' | 'manual'
  requestTimeoutMs: number
  maxTotalTimeoutMs: number
  longRunning: boolean
  persistent: boolean
}
