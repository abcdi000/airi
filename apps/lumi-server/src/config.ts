import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import * as v from 'valibot'

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
    model: v.pipe(v.string(), v.nonEmpty()),
    temperature: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(2))),
    maxOutputTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    maxSteps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64)), 8),
    thinkingMode: v.optional(v.picklist(['auto', 'enabled', 'disabled']), 'auto'),
    reasoningEffort: v.optional(v.picklist(['auto', 'high', 'max']), 'auto'),
    providerOptions: v.optional(v.record(v.string(), v.unknown()), {}),
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
export type LumiServerProcessConfig = Omit<ParsedServerConfig, 'vector' | 'background'> & {
  vector: NonNullable<ParsedServerConfig['vector']>
  background: NonNullable<ParsedServerConfig['background']>
  plugins: NonNullable<ParsedServerConfig['plugins']>
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
  return {
    ...config,
    dataDirectory: resolve(dirname(configPath), config.dataDirectory),
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
      model: 'deepseek-v4-flash',
      maxSteps: 8,
      thinkingMode: 'auto',
      reasoningEffort: 'auto',
      providerOptions: {},
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
