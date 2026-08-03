import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import * as v from 'valibot'

const DOGGY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
const MOUSSY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000002'

function defaultAstrBotIdentityBindings() {
  return [
    ...['1770249418', '1931972861', '2986464928'].map(externalUserId => ({
      platformInstanceId: 'default',
      externalUserId,
      personId: DOGGY_PERSON_ID,
    })),
    ...['1428755063', '3884583060', '3274405364'].map(externalUserId => ({
      platformInstanceId: 'default',
      externalUserId,
      personId: MOUSSY_PERSON_ID,
    })),
  ]
}

const McpServerSchema = v.object({
  command: v.optional(v.string()),
  url: v.optional(v.pipe(v.string(), v.url())),
  args: v.optional(v.array(v.string())),
  env: v.optional(v.record(v.string(), v.string())),
  headers: v.optional(v.record(v.string(), v.string())),
  cwd: v.optional(v.string()),
  enabled: v.optional(v.boolean(), true),
  startupMode: v.optional(v.picklist(['on_startup', 'on_first_use', 'manual']), 'on_startup'),
  longRunning: v.optional(v.boolean(), false),
  persistent: v.optional(v.boolean(), false),
  requestTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(600_000))),
  maxTotalTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(900_000))),
})

const Sub2ApiProviderOptionsSchema = v.object({
  protocol: v.optional(v.picklist(['auto', 'responses', 'chat-completions']), 'auto'),
  accountApiBaseURL: v.optional(v.pipe(v.string(), v.url())),
  reasoningEffort: v.optional(v.picklist(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']), 'auto'),
})

const ServerConfigSchema = v.object({
  dataDirectory: v.pipe(v.string(), v.nonEmpty()),
  authSecret: v.pipe(v.string(), v.minLength(32)),
  publicBaseURL: v.pipe(v.string(), v.url()),
  hostname: v.optional(v.string(), '127.0.0.1'),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)), 6_130),
  trustedOrigins: v.optional(v.array(v.pipe(v.string(), v.url())), []),
  serverVersion: v.optional(v.pipe(v.string(), v.nonEmpty()), '0.10.2'),
  manager: v.object({
    token: v.pipe(v.string(), v.minLength(32)),
    port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535)), 6_131),
  }),
  personaPrompt: v.pipe(v.string(), v.nonEmpty()),
  model: v.object({
    providerId: v.optional(v.string(), 'deepseek'),
    baseURL: v.pipe(v.string(), v.url()),
    apiKey: v.optional(v.string()),
    accountAccessToken: v.optional(v.string()),
    model: v.pipe(v.string(), v.nonEmpty()),
    temperature: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(2))),
    maxOutputTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(384_000))),
    maxContextTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(32_000), v.maxValue(1_000_000)), 1_000_000),
    outputReserveTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_024), v.maxValue(384_000)), 64_000),
    promptReserveTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_024), v.maxValue(200_000)), 32_000),
    maxSteps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 8),
    thinkingMode: v.optional(v.picklist(['auto', 'enabled', 'disabled']), 'auto'),
    reasoningEffort: v.optional(v.picklist(['auto', 'high', 'max']), 'auto'),
    providerOptions: v.optional(v.record(v.string(), v.unknown()), {}),
  }),
  agentRuntime: v.optional(v.object({
    promptDirectory: v.optional(v.string()),
    mode: v.optional(v.picklist(['legacy', 'shadow', 'maisaka']), 'maisaka'),
    plannerMaxRounds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32)), 10),
    plannerFinalizationMode: v.optional(v.picklist(['maibot', 'stop_after_successful_reply']), 'stop_after_successful_reply'),
    mergeWindowMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5_000)), 80),
    toolMaxConcurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(32)), 4),
    toolStepTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(600_000)), 30_000),
    deferredToolsEnabled: v.optional(v.boolean(), true),
    expressionSelectorEnabled: v.optional(v.boolean(), true),
    directLanguageFeedbackEnabled: v.optional(v.boolean(), true),
    promptLoggingEnabled: v.optional(v.boolean(), false),
    plannerHistoryBudgetTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(1_000_000)), 700_000),
    contextCompactionThresholdTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2_000), v.maxValue(1_000_000)), 760_000),
    contextRecentTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(900_000)), 160_000),
  }), {
    mode: 'maisaka',
    plannerMaxRounds: 10,
    plannerFinalizationMode: 'stop_after_successful_reply',
    mergeWindowMs: 80,
    toolMaxConcurrency: 4,
    toolStepTimeoutMs: 30_000,
    deferredToolsEnabled: true,
    expressionSelectorEnabled: true,
    directLanguageFeedbackEnabled: true,
    promptLoggingEnabled: false,
    plannerHistoryBudgetTokens: 700_000,
    contextCompactionThresholdTokens: 760_000,
    contextRecentTokens: 160_000,
  }),
  languageLearning: v.optional(v.object({
    enabled: v.optional(v.boolean(), true),
    directLanguageCandidateLearningEnabled: v.optional(v.boolean(), false),
    groupExpressionLearningEnabled: v.optional(v.boolean(), true),
    groupJargonLearningEnabled: v.optional(v.boolean(), true),
    groupBehaviorLearningEnabled: v.optional(v.boolean(), true),
    groupPublicKnowledgeLearningEnabled: v.optional(v.boolean(), true),
    expressionLearningEnabled: v.optional(v.boolean(), true),
    behaviorLearningEnabled: v.optional(v.boolean(), true),
    jargonLearningEnabled: v.optional(v.boolean(), true),
    selfExpressionLearningEnabled: v.optional(v.boolean(), true),
    globalDiffusionEnabled: v.optional(v.boolean(), true),
    maxSelectedExpressions: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(3)), 3),
    vectorCandidateLimit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)), 24),
    preciseSelectorEnabled: v.optional(v.boolean(), true),
    feedbackLearningEnabled: v.optional(v.boolean(), true),
    promptLoggingEnabled: v.optional(v.boolean(), false),
    multiMessageReplyEnabled: v.optional(v.boolean(), true),
  }), {
    enabled: true,
    directLanguageCandidateLearningEnabled: false,
    groupExpressionLearningEnabled: true,
    groupJargonLearningEnabled: true,
    groupBehaviorLearningEnabled: true,
    groupPublicKnowledgeLearningEnabled: true,
    expressionLearningEnabled: true,
    behaviorLearningEnabled: true,
    jargonLearningEnabled: true,
    selfExpressionLearningEnabled: true,
    globalDiffusionEnabled: true,
    maxSelectedExpressions: 3,
    vectorCandidateLimit: 24,
    preciseSelectorEnabled: true,
    feedbackLearningEnabled: true,
    promptLoggingEnabled: false,
    multiMessageReplyEnabled: true,
  }),
  transcription: v.optional(v.object({
    providerId: v.optional(v.string(), 'openai'),
    enabled: v.optional(v.boolean(), false),
    baseURL: v.pipe(v.string(), v.url()),
    apiKey: v.optional(v.string()),
    model: v.pipe(v.string(), v.nonEmpty()),
    language: v.optional(v.string()),
    prompt: v.optional(v.string()),
    maxVoiceBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100 * 1024 * 1024)), 25 * 1024 * 1024),
  })),
  vision: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    baseURL: v.pipe(v.string(), v.url()),
    apiKey: v.optional(v.string()),
    model: v.pipe(v.string(), v.nonEmpty()),
  })),
  astrbot: v.optional(v.object({
    enabled: v.optional(v.boolean(), false),
    apiToken: v.pipe(v.string(), v.minLength(32)),
    identityBindings: v.optional(v.array(v.object({
      platformInstanceId: v.pipe(v.string(), v.nonEmpty()),
      externalUserId: v.pipe(v.string(), v.nonEmpty()),
      personId: v.pipe(v.string(), v.nonEmpty()),
    })), []),
    maxImageBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100 * 1024 * 1024)), 10 * 1024 * 1024),
    maxAudioBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100 * 1024 * 1024)), 25 * 1024 * 1024),
    responseTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000), v.maxValue(600_000)), 300_000),
    maxRequestBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_024), v.maxValue(200 * 1024 * 1024)), 50 * 1024 * 1024),
    privateReplyEnabled: v.optional(v.boolean()),
    groupObservationEnabled: v.optional(v.boolean()),
    // NOTICE:
    // This field is accepted only for one-time migration of Server configs
    // created before private replies and group observation became independent.
    learningMode: v.optional(v.picklist(['normal', 'observe_only'])),
    studyGroups: v.optional(v.array(v.object({
      id: v.pipe(v.string(), v.nonEmpty()),
      platformInstanceId: v.pipe(v.string(), v.nonEmpty()),
      groupId: v.pipe(v.string(), v.nonEmpty()),
      displayName: v.pipe(v.string(), v.nonEmpty()),
      enabled: v.optional(v.boolean(), true),
      priority: v.optional(v.picklist(['normal', 'high']), 'normal'),
    })), []),
    observationBatchSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(5), v.maxValue(200)), 20),
    stickerLibrary: v.optional(v.object({
      enabled: v.optional(v.boolean(), true),
      collectFromStudyGroups: v.optional(v.boolean(), true),
      relativePath: v.optional(v.pipe(v.string(), v.nonEmpty()), 'lumi-stickers'),
      maximumItems: v.optional(v.pipe(v.number(), v.integer(), v.minValue(16), v.maxValue(5_000)), 256),
      sendProbability: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(1)), 0.18),
      cooldownMessages: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)), 3),
    }), {
      enabled: true,
      collectFromStudyGroups: true,
      relativePath: 'lumi-stickers',
      maximumItems: 256,
      sendProbability: 0.18,
      cooldownMessages: 3,
    }),
  })),
  mcp: v.optional(v.object({
    mcpServers: v.record(v.string(), McpServerSchema),
  }), { mcpServers: {} }),
  plugins: v.optional(v.object({
    directory: v.optional(v.string()),
    enabled: v.optional(v.array(v.string()), []),
    settings: v.optional(v.record(v.string(), v.record(v.string(), v.unknown())), {}),
  }), { enabled: [] }),
  vector: v.optional(v.object({
    enabled: v.optional(v.boolean(), true),
    pythonPath: v.optional(v.string()),
    pythonArguments: v.optional(v.array(v.string()), []),
    workerScriptPath: v.optional(v.string()),
    modelCacheRoot: v.optional(v.string()),
    bundledModelCacheRoot: v.optional(v.string()),
    model: v.optional(v.string(), 'BAAI/bge-small-zh-v1.5'),
    device: v.optional(v.picklist(['auto', 'cpu', 'cuda', 'mps']), 'auto'),
  }), {
    enabled: true,
    pythonArguments: [],
    model: 'BAAI/bge-small-zh-v1.5',
    device: 'auto',
  }),
  background: v.optional(v.object({
    diary: v.optional(v.object({
      enabled: v.optional(v.boolean(), true),
      dailyTime: v.optional(v.pipe(v.string(), v.regex(/^\d{1,2}:\d{2}$/)), '23:00'),
    }), { enabled: true, dailyTime: '23:00' }),
    autonomousLife: v.optional(v.object({
      enabled: v.optional(v.boolean(), true),
      minimumIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60_000)), 1_200_000),
      maximumIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(60_000)), 2_700_000),
    }), { enabled: true, minimumIntervalMs: 1_200_000, maximumIntervalMs: 2_700_000 }),
  }), {
    diary: { enabled: true, dailyTime: '23:00' },
    autonomousLife: { enabled: true, minimumIntervalMs: 1_200_000, maximumIntervalMs: 2_700_000 },
  }),
  tls: v.optional(v.object({
    certPath: v.pipe(v.string(), v.nonEmpty()),
    keyPath: v.pipe(v.string(), v.nonEmpty()),
    passphrase: v.optional(v.string()),
  })),
})

type ParsedServerConfig = v.InferOutput<typeof ServerConfigSchema>
type ParsedAstrBotConfig = NonNullable<ParsedServerConfig['astrbot']>
export type LumiServerProcessConfig = Omit<ParsedServerConfig, 'vector' | 'background' | 'astrbot'> & {
  vector: NonNullable<ParsedServerConfig['vector']>
  background: NonNullable<ParsedServerConfig['background']>
  plugins: NonNullable<ParsedServerConfig['plugins']>
  astrbot?: Omit<ParsedAstrBotConfig, 'learningMode' | 'privateReplyEnabled' | 'groupObservationEnabled'> & {
    privateReplyEnabled: boolean
    groupObservationEnabled: boolean
  }
}

/** Reads and validates a Server Manager-owned JSON configuration file. */
export async function loadLumiServerConfig(path: string): Promise<LumiServerProcessConfig> {
  const configPath = resolve(path)
  const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  const config = v.parse(ServerConfigSchema, parsed)
  const vector = config.vector ?? {
    enabled: true,
    pythonArguments: [],
    model: 'BAAI/bge-small-zh-v1.5',
    device: 'auto' as const,
  }
  const background = config.background ?? {
    diary: { enabled: true, dailyTime: '23:00' },
    autonomousLife: { enabled: true, minimumIntervalMs: 1_200_000, maximumIntervalMs: 2_700_000 },
  }
  const plugins = config.plugins ?? { enabled: [], settings: {} }
  let astrbot: LumiServerProcessConfig['astrbot']
  if (config.astrbot) {
    const { learningMode, ...astrbotConfig } = config.astrbot
    astrbot = {
      ...astrbotConfig,
      privateReplyEnabled: config.astrbot.privateReplyEnabled ?? learningMode !== 'observe_only',
      groupObservationEnabled: config.astrbot.groupObservationEnabled ?? learningMode === 'observe_only',
    }
  }
  return {
    ...config,
    model: config.model.providerId === 'sub2api'
      ? {
          ...config.model,
          providerOptions: v.parse(Sub2ApiProviderOptionsSchema, config.model.providerOptions),
        }
      : config.model,
    astrbot,
    dataDirectory: resolve(dirname(configPath), config.dataDirectory),
    agentRuntime: {
      ...config.agentRuntime,
      promptDirectory: config.agentRuntime.promptDirectory
        ? resolve(dirname(configPath), config.agentRuntime.promptDirectory)
        : undefined,
    },
    vector: {
      ...vector,
      pythonPath: vector.pythonPath ? resolve(dirname(configPath), vector.pythonPath) : undefined,
      workerScriptPath: vector.workerScriptPath ? resolve(dirname(configPath), vector.workerScriptPath) : undefined,
      modelCacheRoot: vector.modelCacheRoot ? resolve(dirname(configPath), vector.modelCacheRoot) : undefined,
      bundledModelCacheRoot: vector.bundledModelCacheRoot ? resolve(dirname(configPath), vector.bundledModelCacheRoot) : undefined,
    },
    plugins: {
      ...plugins,
      directory: plugins.directory ? resolve(dirname(configPath), plugins.directory) : undefined,
    },
    background,
    tls: config.tls
      ? {
          ...config.tls,
          certPath: resolve(dirname(configPath), config.tls.certPath),
          keyPath: resolve(dirname(configPath), config.tls.keyPath),
        }
      : undefined,
  }
}

/**
 * Adds newly required integration defaults to an existing Server config.
 *
 * Use when:
 * - Server Manager opens a config created by an older Lumi version
 *
 * Expects:
 * - A valid JSON object at `path`
 *
 * Returns:
 * - Whether the file was changed
 */
export async function upgradeLumiServerConfig(path: string): Promise<boolean> {
  const configPath = resolve(path)
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
  const migrations = (
    raw._managerMigrations
    && typeof raw._managerMigrations === 'object'
    && !Array.isArray(raw._managerMigrations)
      ? raw._managerMigrations
      : {}
  ) as Record<string, unknown>
  let changed = false
  if (!raw.astrbot) {
    raw.astrbot = {
      enabled: false,
      apiToken: randomBytes(48).toString('base64url'),
      identityBindings: defaultAstrBotIdentityBindings(),
      maxImageBytes: 10 * 1024 * 1024,
      maxAudioBytes: 25 * 1024 * 1024,
      responseTimeoutMs: 300_000,
      maxRequestBytes: 50 * 1024 * 1024,
      privateReplyEnabled: true,
      groupObservationEnabled: false,
      studyGroups: [],
      observationBatchSize: 20,
      stickerLibrary: {
        enabled: true,
        collectFromStudyGroups: true,
        relativePath: 'lumi-stickers',
        maximumItems: 256,
        sendProbability: 0.18,
        cooldownMessages: 3,
      },
    }
    changed = true
  }
  if (!migrations.astrbotIdentityDefaultsV1) {
    const astrbot = raw.astrbot as Record<string, unknown>
    if (!Array.isArray(astrbot.identityBindings) || astrbot.identityBindings.length === 0)
      astrbot.identityBindings = defaultAstrBotIdentityBindings()
    migrations.astrbotIdentityDefaultsV1 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!migrations.astrbotIndependentPolicyV2) {
    const astrbot = raw.astrbot as Record<string, unknown>
    const legacyMode = astrbot.learningMode
    if (typeof astrbot.privateReplyEnabled !== 'boolean')
      astrbot.privateReplyEnabled = legacyMode !== 'observe_only'
    if (typeof astrbot.groupObservationEnabled !== 'boolean')
      astrbot.groupObservationEnabled = legacyMode === 'observe_only'
    delete astrbot.learningMode
    migrations.astrbotIndependentPolicyV2 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!raw.languageLearning) {
    raw.languageLearning = {
      enabled: true,
      directLanguageCandidateLearningEnabled: false,
      groupExpressionLearningEnabled: true,
      groupJargonLearningEnabled: true,
      groupBehaviorLearningEnabled: true,
      groupPublicKnowledgeLearningEnabled: true,
      expressionLearningEnabled: true,
      behaviorLearningEnabled: true,
      jargonLearningEnabled: true,
      selfExpressionLearningEnabled: true,
      globalDiffusionEnabled: true,
      maxSelectedExpressions: 3,
      vectorCandidateLimit: 24,
      preciseSelectorEnabled: true,
      feedbackLearningEnabled: true,
      promptLoggingEnabled: false,
      multiMessageReplyEnabled: true,
    }
    changed = true
  }
  if (!migrations.directLanguageCandidateBoundaryV1) {
    const languageLearning = raw.languageLearning as Record<string, unknown>
    languageLearning.directLanguageCandidateLearningEnabled ??= false
    migrations.directLanguageCandidateBoundaryV1 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!migrations.independentGroupCuratorsV1) {
    const languageLearning = raw.languageLearning as Record<string, unknown>
    languageLearning.groupExpressionLearningEnabled ??= true
    languageLearning.groupJargonLearningEnabled ??= true
    languageLearning.groupBehaviorLearningEnabled ??= true
    languageLearning.groupPublicKnowledgeLearningEnabled ??= true
    migrations.independentGroupCuratorsV1 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!migrations.consciousnessContextAndExpressionTrialV1) {
    const model = raw.model as Record<string, unknown>
    model.maxContextTokens ??= 1_000_000
    model.outputReserveTokens ??= 64_000
    model.promptReserveTokens ??= 32_000
    const languageLearning = raw.languageLearning as Record<string, unknown> | undefined
    if (languageLearning)
      languageLearning.preciseSelectorEnabled = true
    migrations.consciousnessContextAndExpressionTrialV1 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!migrations.sharedAgentRuntimeV1) {
    raw.agentRuntime ??= {
      promptDirectory: './prompts',
      mode: 'shadow',
      plannerMaxRounds: 10,
      plannerFinalizationMode: 'stop_after_successful_reply',
      mergeWindowMs: 80,
      toolMaxConcurrency: 4,
      toolStepTimeoutMs: 30_000,
      deferredToolsEnabled: true,
      expressionSelectorEnabled: true,
      directLanguageFeedbackEnabled: true,
      promptLoggingEnabled: false,
      plannerHistoryBudgetTokens: 700_000,
      contextCompactionThresholdTokens: 760_000,
      contextRecentTokens: 160_000,
    }
    migrations.sharedAgentRuntimeV1 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!migrations.agentPromptOverridesV1) {
    const agentRuntime = raw.agentRuntime as Record<string, unknown>
    agentRuntime.promptDirectory ??= './prompts'
    migrations.agentPromptOverridesV1 = true
    raw._managerMigrations = migrations
    changed = true
  }
  if (!changed)
    return false

  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  return true
}

/** Creates a private starter config without replacing an existing file. */
export async function initializeLumiServerConfig(path: string): Promise<string> {
  const configPath = resolve(path)
  await mkdir(dirname(configPath), { recursive: true })
  const template: LumiServerProcessConfig = {
    dataDirectory: './data',
    authSecret: randomBytes(48).toString('base64url'),
    publicBaseURL: 'http://127.0.0.1:6130',
    hostname: '127.0.0.1',
    port: 6_130,
    trustedOrigins: [],
    serverVersion: '0.10.2',
    manager: {
      token: randomBytes(48).toString('base64url'),
      port: 6_131,
    },
    personaPrompt: 'You are Lumi, a continuous AI companion with your own stable identity, memories, emotions, relationships, and boundaries.',
    model: {
      providerId: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: '',
      accountAccessToken: '',
      model: 'deepseek-v4-flash',
      maxContextTokens: 1_000_000,
      outputReserveTokens: 64_000,
      promptReserveTokens: 32_000,
      maxSteps: 8,
      thinkingMode: 'auto',
      reasoningEffort: 'auto',
      providerOptions: {},
    },
    agentRuntime: {
      promptDirectory: './prompts',
      mode: 'maisaka',
      plannerMaxRounds: 10,
      plannerFinalizationMode: 'stop_after_successful_reply',
      mergeWindowMs: 80,
      toolMaxConcurrency: 4,
      toolStepTimeoutMs: 30_000,
      deferredToolsEnabled: true,
      expressionSelectorEnabled: true,
      directLanguageFeedbackEnabled: true,
      promptLoggingEnabled: false,
      plannerHistoryBudgetTokens: 700_000,
      contextCompactionThresholdTokens: 760_000,
      contextRecentTokens: 160_000,
    },
    languageLearning: {
      enabled: true,
      directLanguageCandidateLearningEnabled: false,
      groupExpressionLearningEnabled: true,
      groupJargonLearningEnabled: true,
      groupBehaviorLearningEnabled: true,
      groupPublicKnowledgeLearningEnabled: true,
      expressionLearningEnabled: true,
      behaviorLearningEnabled: true,
      jargonLearningEnabled: true,
      selfExpressionLearningEnabled: true,
      globalDiffusionEnabled: true,
      maxSelectedExpressions: 3,
      vectorCandidateLimit: 24,
      preciseSelectorEnabled: true,
      feedbackLearningEnabled: true,
      promptLoggingEnabled: false,
      multiMessageReplyEnabled: true,
    },
    transcription: {
      providerId: 'openai',
      enabled: false,
      baseURL: 'https://api.openai.com/v1/',
      apiKey: '',
      model: 'whisper-1',
      language: 'zh',
      maxVoiceBytes: 25 * 1024 * 1024,
    },
    vision: {
      enabled: false,
      baseURL: 'https://api.openai.com/v1/',
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    astrbot: {
      enabled: false,
      apiToken: randomBytes(48).toString('base64url'),
      identityBindings: defaultAstrBotIdentityBindings(),
      maxImageBytes: 10 * 1024 * 1024,
      maxAudioBytes: 25 * 1024 * 1024,
      responseTimeoutMs: 300_000,
      maxRequestBytes: 50 * 1024 * 1024,
      privateReplyEnabled: true,
      groupObservationEnabled: false,
      studyGroups: [],
      observationBatchSize: 20,
      stickerLibrary: {
        enabled: true,
        collectFromStudyGroups: true,
        relativePath: 'lumi-stickers',
        maximumItems: 256,
        sendProbability: 0.18,
        cooldownMessages: 3,
      },
    },
    mcp: { mcpServers: {} },
    plugins: { enabled: [], settings: {} },
    vector: {
      enabled: true,
      pythonArguments: [],
      model: 'BAAI/bge-small-zh-v1.5',
      device: 'auto',
    },
    background: {
      diary: { enabled: true, dailyTime: '23:00' },
      autonomousLife: { enabled: true, minimumIntervalMs: 1_200_000, maximumIntervalMs: 2_700_000 },
    },
  }
  await writeFile(configPath, `${JSON.stringify(template, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return configPath
}
