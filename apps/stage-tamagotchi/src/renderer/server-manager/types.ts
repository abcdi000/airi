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
      accountAccessTokenSet: boolean
      temperature?: number
      maxOutputTokens?: number
      maxContextTokens: number
      outputReserveTokens: number
      promptReserveTokens: number
      maxSteps: number
      thinkingMode: 'auto' | 'enabled' | 'disabled'
      reasoningEffort: 'auto' | 'high' | 'max'
      providerOptions: Record<string, unknown>
    }
    agentRuntime: {
      promptDirectory?: string
      mode: 'legacy' | 'shadow' | 'maisaka'
      plannerMaxRounds: number
      plannerFinalizationMode: 'maibot' | 'stop_after_successful_reply'
      mergeWindowMs: number
      toolMaxConcurrency: number
      toolStepTimeoutMs: number
      deferredToolsEnabled: boolean
      expressionSelectorEnabled: boolean
      directLanguageFeedbackEnabled: boolean
      promptLoggingEnabled: boolean
      plannerHistoryBudgetTokens: number
      contextCompactionThresholdTokens: number
      contextRecentTokens: number
    }
    languageLearning: {
      directLanguageCandidateLearningEnabled: boolean
      groupExpressionLearningEnabled: boolean
      groupJargonLearningEnabled: boolean
      groupBehaviorLearningEnabled: boolean
      groupPublicKnowledgeLearningEnabled: boolean
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
      privateReplyEnabled: boolean
      groupObservationEnabled: boolean
      studyGroups: Array<{
        id: string
        platformInstanceId: string
        groupId: string
        displayName: string
        enabled: boolean
        priority: 'normal' | 'high'
      }>
      observationBatchSize: number
      stickerLibrary: {
        enabled: boolean
        collectFromStudyGroups: boolean
        relativePath: string
        maximumItems: number
        sendProbability: number
        cooldownMessages: number
      }
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
export interface ProviderModel {
  id: string
  displayName?: string
  ownedBy?: string
  source?: 'openai-list' | 'codex-manifest' | 'static'
}
export interface ProviderBalance { available: boolean, balances: Array<{ currency: string, total: string, granted: string, toppedUp: string }> }
export interface ProviderTestResult {
  ok: boolean
  protocol: 'responses' | 'chat-completions'
  endpoint: string
  requestedModel: string
  resolvedModel?: string
  text: string
  firstTokenMs?: number
  durationMs: number
  requestId?: string
  responseId?: string
  usage?: {
    inputTokens?: number
    cachedInputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  fallbackUsed?: boolean
}
export interface ProviderAdvancedTestResult {
  ok: boolean
  kind: 'multi-turn' | 'planner-tool'
  protocol: 'responses' | 'chat-completions'
  durationMs: number
  rounds: number
  text: string
  callId?: string
  fallbackUsed: boolean
}
export interface ProviderAccountStatus {
  providerId: 'sub2api'
  fetchedAt: string
  accountTokenConfigured: boolean
  wallet?: { balance: number, frozenBalance?: number, status?: string }
  limits?: { concurrency?: number, rpmLimit?: number }
  platformQuotas?: Array<{
    platform: string
    dailyLimitUsd?: number | null
    weeklyLimitUsd?: number | null
    monthlyLimitUsd?: number | null
    dailyUsageUsd: number
    weeklyUsageUsd: number
    monthlyUsageUsd: number
    dailyWindowResetsAt?: string | null
    weeklyWindowResetsAt?: string | null
    monthlyWindowResetsAt?: string | null
  }>
  billingRate?: {
    groupRateMultiplier?: number
    userRateMultiplier?: number
    resolvedRateMultiplier?: number
    peakRateEnabled?: boolean
    peakStart?: string
    peakEnd?: string
    peakRateMultiplier?: number
    appliedPeakMultiplier?: number
    effectiveRateMultiplier?: number
    observedAt?: string
    timezone?: string
  }
  partialErrors: Array<{ source: 'profile' | 'platform-quotas' | 'billing-rate', status?: number, message: string }>
}
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
