import type { BrowserBackendName, BrowserLaunchSettings, BrowserName } from './browser-contracts'

import process from 'node:process'

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface PluginSpec {
  module: string
  enabled?: boolean
  options?: Record<string, unknown>
}

export interface BrowserIdentityExpectation {
  userAgent?: string
  platform?: string
  language?: string
  languages?: string[]
  timeZone?: string
  screen?: {
    width: number
    height: number
    availWidth: number
    availHeight: number
    colorDepth: number
    pixelDepth: number
  }
  devicePixelRatio?: number
  hardwareConcurrency?: number
  colorScheme?: 'dark' | 'light' | 'no-preference'
}

export interface BrowserBehaviorConfig {
  navigationReadyTimeoutMs?: number
  postNavigationSettleMs?: number
}

export interface BrowserBackendFileConfig {
  browserName?: BrowserName
  channel?: string
  headless?: boolean
  persistentContext?: boolean
  noViewport?: boolean
  launchOptions?: Record<string, unknown>
}

export interface LauncherFileConfig {
  userDataDir?: string
  browser?: {
    defaultBackend?: BrowserBackendName
    fallbackBackend?: BrowserBackendName | null
    platformOverrides?: Record<string, BrowserBackendName>
    patchright?: BrowserBackendFileConfig
    playwright?: BrowserBackendFileConfig
  }
  plugins?: PluginSpec[]
  identity?: BrowserIdentityExpectation
  behavior?: BrowserBehaviorConfig
  initScripts?: string[]
  setupModules?: string[]
  mcp?: Record<string, unknown>
}

export interface LauncherConfig {
  configDir: string
  userDataDir: string
  browser: {
    defaultBackend: BrowserBackendName
    fallbackBackend?: BrowserBackendName
    platformOverrides: Record<string, BrowserBackendName>
    backends: Record<BrowserBackendName, BrowserLaunchSettings>
  }
  plugins: PluginSpec[]
  identity?: BrowserIdentityExpectation
  behavior: Required<BrowserBehaviorConfig>
  initScripts: string[]
  setupModules: string[]
  mcp: Record<string, unknown>
  startupRequest: {
    backend?: BrowserBackendName
    platform?: string
    browserName?: BrowserName
  }
}

interface CliOverrides {
  configPath?: string
  userDataDir?: string
  backend?: BrowserBackendName
  platform?: string
  browserName?: BrowserName
  channel?: string
  headless?: boolean
  stealth?: boolean
  plugins: string[]
  initScripts: string[]
  setupModules: string[]
}

const DEFAULT_STEALTH_PLUGIN = 'puppeteer-extra-plugin-stealth'
const DEFAULT_BEHAVIOR: Required<BrowserBehaviorConfig> = {
  navigationReadyTimeoutMs: 15_000,
  postNavigationSettleMs: 350,
}

function takeValue(args: string[], index: number, name: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value`)
  return value
}

function parseBackend(value: string, source: string): BrowserBackendName {
  if (value === 'patchright' || value === 'playwright')
    return value
  throw new Error(`${source} must be "patchright" or "playwright"`)
}

function parseBrowserName(value: string, source: string): BrowserName {
  if (value === 'chromium' || value === 'firefox' || value === 'webkit')
    return value
  throw new Error(`${source} must be "chromium", "firefox", or "webkit"`)
}

export function parseCliArgs(args: string[]): CliOverrides {
  const result: CliOverrides = {
    plugins: [],
    initScripts: [],
    setupModules: [],
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '--config':
        result.configPath = takeValue(args, index, arg)
        index += 1
        break
      case '--user-data-dir':
        result.userDataDir = takeValue(args, index, arg)
        index += 1
        break
      case '--backend':
        result.backend = parseBackend(takeValue(args, index, arg), arg)
        index += 1
        break
      case '--platform':
        result.platform = takeValue(args, index, arg)
        index += 1
        break
      case '--browser':
        result.browserName = parseBrowserName(takeValue(args, index, arg), arg)
        index += 1
        break
      case '--channel':
        result.channel = takeValue(args, index, arg)
        index += 1
        break
      case '--headless':
        result.headless = true
        break
      case '--headed':
        result.headless = false
        break
      case '--no-stealth':
        result.stealth = false
        break
      case '--stealth':
        result.stealth = true
        break
      case '--plugin':
        result.plugins.push(takeValue(args, index, arg))
        index += 1
        break
      case '--init-script':
        result.initScripts.push(takeValue(args, index, arg))
        index += 1
        break
      case '--setup-module':
        result.setupModules.push(takeValue(args, index, arg))
        index += 1
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return result
}

function resolveFrom(baseDir: string, value: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value)
}

function parseEnvironmentBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined)
    return undefined
  if (value === '1' || value.toLowerCase() === 'true')
    return true
  if (value === '0' || value.toLowerCase() === 'false')
    return false
  throw new Error(`Invalid boolean environment value: ${value}`)
}

function resolvedBackendConfig(
  backend: BrowserBackendName,
  fileConfig: BrowserBackendFileConfig | undefined,
  profilePath: string,
  cli: CliOverrides,
  env: NodeJS.ProcessEnv,
): BrowserLaunchSettings {
  const envPrefix = backend === 'patchright' ? 'LUMI_PATCHRIGHT' : 'LUMI_PLAYWRIGHT'
  const envHeadless = parseEnvironmentBoolean(env[`${envPrefix}_HEADLESS`])
  const envPersistent = parseEnvironmentBoolean(env[`${envPrefix}_PERSISTENT_CONTEXT`])
  const envNoViewport = parseEnvironmentBoolean(env[`${envPrefix}_NO_VIEWPORT`])

  return {
    browserName: cli.browserName
      ?? (env[`${envPrefix}_BROWSER`] ? parseBrowserName(env[`${envPrefix}_BROWSER`]!, `${envPrefix}_BROWSER`) : undefined)
      ?? fileConfig?.browserName
      ?? 'chromium',
    channel: cli.channel
      ?? env[`${envPrefix}_CHANNEL`]
      ?? fileConfig?.channel
      ?? 'chrome',
    headless: cli.headless
      ?? envHeadless
      ?? fileConfig?.headless
      ?? false,
    persistentContext: envPersistent
      ?? fileConfig?.persistentContext
      ?? true,
    noViewport: envNoViewport
      ?? fileConfig?.noViewport
      ?? true,
    profilePath,
    launchOptions: fileConfig?.launchOptions ?? {},
  }
}

export async function loadLauncherConfig(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<LauncherConfig> {
  const cli = parseCliArgs(args)
  const configPath = cli.configPath ? resolveFrom(cwd, cli.configPath) : undefined
  const configDir = configPath ? dirname(configPath) : cwd
  const fileConfig: LauncherFileConfig = configPath
    ? JSON.parse(await readFile(configPath, 'utf8')) as LauncherFileConfig
    : {}

  const defaultBackend = env.LUMI_BROWSER_DEFAULT_BACKEND
    ? parseBackend(env.LUMI_BROWSER_DEFAULT_BACKEND, 'LUMI_BROWSER_DEFAULT_BACKEND')
    : fileConfig.browser?.defaultBackend ?? 'patchright'
  const fallbackValue = env.LUMI_BROWSER_FALLBACK_BACKEND
  const fallbackBackend = fallbackValue === 'none'
    ? undefined
    : fallbackValue
      ? parseBackend(fallbackValue, 'LUMI_BROWSER_FALLBACK_BACKEND')
      : fileConfig.browser?.fallbackBackend === null
        ? undefined
        : fileConfig.browser?.fallbackBackend ?? 'playwright'
  const profileValue = cli.userDataDir
    ?? env.LUMI_BROWSER_PROFILE_PATH
    ?? env.LUMI_PLAYWRIGHT_USER_DATA_DIR
    ?? fileConfig.userDataDir
    ?? resolve(cwd, 'data', 'browser_profiles', 'lumi')
  const userDataDir = resolveFrom(configDir, profileValue)
  const configuredPlugins = fileConfig.plugins ?? []
  const stealthEnabled = cli.stealth ?? true
  const plugins = configuredPlugins
    .filter(plugin => plugin.enabled !== false)
    .filter(plugin => stealthEnabled || plugin.module !== DEFAULT_STEALTH_PLUGIN)
    .concat(cli.plugins.map(module => ({ module })))

  if (stealthEnabled && !plugins.some(plugin => plugin.module === DEFAULT_STEALTH_PLUGIN))
    plugins.unshift({ module: DEFAULT_STEALTH_PLUGIN })

  return {
    configDir,
    userDataDir,
    browser: {
      defaultBackend,
      fallbackBackend,
      platformOverrides: fileConfig.browser?.platformOverrides ?? {},
      backends: {
        patchright: resolvedBackendConfig('patchright', fileConfig.browser?.patchright, userDataDir, cli, env),
        playwright: resolvedBackendConfig('playwright', fileConfig.browser?.playwright, userDataDir, cli, env),
      },
    },
    plugins,
    identity: fileConfig.identity,
    behavior: {
      navigationReadyTimeoutMs: fileConfig.behavior?.navigationReadyTimeoutMs
        ?? DEFAULT_BEHAVIOR.navigationReadyTimeoutMs,
      postNavigationSettleMs: fileConfig.behavior?.postNavigationSettleMs
        ?? DEFAULT_BEHAVIOR.postNavigationSettleMs,
    },
    initScripts: [
      ...(fileConfig.initScripts ?? []),
      ...cli.initScripts,
    ].map(scriptPath => resolveFrom(configDir, scriptPath)),
    setupModules: [
      ...(fileConfig.setupModules ?? []),
      ...cli.setupModules,
    ],
    mcp: fileConfig.mcp ?? {},
    startupRequest: {
      backend: cli.backend ?? (env.LUMI_BROWSER_BACKEND ? parseBackend(env.LUMI_BROWSER_BACKEND, 'LUMI_BROWSER_BACKEND') : undefined),
      platform: cli.platform ?? env.LUMI_BROWSER_PLATFORM,
      browserName: cli.browserName,
    },
  }
}
