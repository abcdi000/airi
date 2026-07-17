import type { BrowserType } from 'playwright'

import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'

export interface PluginSpec {
  module: string
  enabled?: boolean
  options?: Record<string, unknown>
}

export type LaunchPersistentContextOptions = Parameters<BrowserType['launchPersistentContext']>[1]

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

export interface LauncherFileConfig {
  userDataDir?: string
  browser?: {
    channel?: string
    headless?: boolean
    launchOptions?: LaunchPersistentContextOptions
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
    channel: string
    headless: boolean
    launchOptions: LaunchPersistentContextOptions
  }
  plugins: PluginSpec[]
  identity?: BrowserIdentityExpectation
  behavior: Required<BrowserBehaviorConfig>
  initScripts: string[]
  setupModules: string[]
  mcp: Record<string, unknown>
}

interface CliOverrides {
  configPath?: string
  userDataDir?: string
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

  const envHeadless = parseEnvironmentBoolean(env.LUMI_PLAYWRIGHT_HEADLESS)
  const configuredPlugins = fileConfig.plugins ?? [{ module: DEFAULT_STEALTH_PLUGIN }]
  const stealthEnabled = cli.stealth ?? true
  const plugins = configuredPlugins
    .filter(plugin => plugin.enabled !== false)
    .filter(plugin => stealthEnabled || plugin.module !== DEFAULT_STEALTH_PLUGIN)
    .concat(cli.plugins.map(module => ({ module })))

  if (stealthEnabled && !plugins.some(plugin => plugin.module === DEFAULT_STEALTH_PLUGIN))
    plugins.unshift({ module: DEFAULT_STEALTH_PLUGIN })

  const userDataDirValue = cli.userDataDir
    ?? env.LUMI_PLAYWRIGHT_USER_DATA_DIR
    ?? fileConfig.userDataDir
    ?? resolve(cwd, '.playwright-mcp', 'profile')

  return {
    configDir,
    userDataDir: resolveFrom(configDir, userDataDirValue),
    browser: {
      channel: cli.channel
        ?? env.LUMI_PLAYWRIGHT_CHANNEL
        ?? fileConfig.browser?.channel
        ?? 'chrome',
      headless: cli.headless
        ?? envHeadless
        ?? fileConfig.browser?.headless
        ?? false,
      launchOptions: fileConfig.browser?.launchOptions ?? {},
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
  }
}
