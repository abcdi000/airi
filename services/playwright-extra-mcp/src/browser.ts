import type { BrowserContext, Page } from 'playwright'
import type { BrowserBehaviorConfig, BrowserIdentityExpectation, LauncherConfig, LaunchPersistentContextOptions, PluginSpec } from './config'

import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { chromium } from 'playwright-extra'

type ImportModule = (specifier: string) => Promise<Record<string, unknown>>

interface ExtraChromium {
  use: (plugin: unknown) => ExtraChromium
  launchPersistentContext: (
    userDataDir: string,
    options: LaunchPersistentContextOptions,
  ) => Promise<BrowserContext>
}

export interface BrowserDependencies {
  chromium: ExtraChromium
  importModule: ImportModule
}

const defaultDependencies: BrowserDependencies = {
  chromium: chromium as unknown as ExtraChromium,
  importModule: specifier => import(specifier) as Promise<Record<string, unknown>>,
}

const NAVIGATOR_WEBDRIVER_HARDENING = `
(() => {
  const prototype = Object.getPrototypeOf(navigator)
  try {
    delete prototype.webdriver
  }
  catch {}
  if ('webdriver' in navigator) {
    Object.defineProperty(prototype, 'webdriver', {
      configurable: true,
      get: () => undefined,
    })
  }
})()
`

const instrumentedPages = new WeakSet<object>()
const navigationForensicsInstalledPages = new WeakSet<object>()

interface BrowserIdentityActual {
  userAgent: string
  platform: string
  language: string
  languages: string[]
  timeZone: string
  screen: BrowserIdentityExpectation['screen']
  devicePixelRatio: number
  hardwareConcurrency: number
  colorScheme: 'dark' | 'light' | 'no-preference'
}

function importSpecifier(specifier: string, configDir: string): string {
  if (specifier.startsWith('.') || isAbsolute(specifier))
    return pathToFileURL(resolve(configDir, specifier)).href
  return specifier
}

function moduleCallable(module: Record<string, unknown>, exportName: string): (...args: unknown[]) => unknown {
  const candidate = module[exportName] ?? module.default
  if (typeof candidate !== 'function')
    throw new TypeError(`Module does not export a callable ${exportName} or default function`)
  return candidate as (...args: unknown[]) => unknown
}

export async function installPlugins(
  specs: PluginSpec[],
  configDir: string,
  dependencies: BrowserDependencies = defaultDependencies,
): Promise<string[]> {
  const installed: string[] = []
  for (const spec of specs) {
    const imported = await dependencies.importModule(importSpecifier(spec.module, configDir))
    const createPlugin = moduleCallable(imported, 'createPlugin')
    dependencies.chromium.use(createPlugin(spec.options ?? {}))
    installed.push(spec.module)
  }
  return installed
}

export async function waitForPageContentReady(
  page: Page,
  behavior: Required<BrowserBehaviorConfig>,
): Promise<void> {
  const timeout = behavior.navigationReadyTimeoutMs
  if (timeout > 0) {
    await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => undefined)
    await page.waitForFunction(
      () => document.readyState === 'interactive' || document.readyState === 'complete',
      undefined,
      { timeout },
    ).catch(() => undefined)
  }

  if (behavior.postNavigationSettleMs > 0)
    await page.waitForTimeout(behavior.postNavigationSettleMs)
}

function describeNavigationUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  }
  catch {
    return url
  }
}

function logNavigationEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.error(`[lumi-playwright] navigation ${event}: ${JSON.stringify(fields)}`)
}

/**
 * Observe navigation outside the page so a reproduction can distinguish a
 * site-triggered redirect from a subsequent MCP action without exposing URLs'
 * query strings, cookies, or page content.
 */
export function installNavigationForensics(page: Page): void {
  if (navigationForensicsInstalledPages.has(page))
    return

  navigationForensicsInstalledPages.add(page)
  let lastMainFrameUrl = describeNavigationUrl(page.url())

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame())
      return

    const nextUrl = describeNavigationUrl(frame.url())
    logNavigationEvent('main-frame-navigated', { from: lastMainFrameUrl, to: nextUrl })
    lastMainFrameUrl = nextUrl
  })
  page.on('requestfailed', (request) => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame())
      return

    logNavigationEvent('main-document-request-failed', {
      url: describeNavigationUrl(request.url()),
      failure: request.failure()?.errorText ?? 'unknown',
    })
  })
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'document' || response.frame() !== page.mainFrame() || response.status() < 400)
      return

    logNavigationEvent('main-document-http-error', {
      url: describeNavigationUrl(response.url()),
      status: response.status(),
    })
  })
  page.on('pageerror', error => logNavigationEvent('page-error', { message: error.message }))
  page.on('close', () => logNavigationEvent('page-closed', { lastUrl: lastMainFrameUrl }))
}

export function installNavigationReadinessPolicy(
  context: BrowserContext,
  behavior: Required<BrowserBehaviorConfig>,
): void {
  const attach = (page: Page) => {
    if (instrumentedPages.has(page))
      return

    instrumentedPages.add(page)
    installNavigationForensics(page)
    const originalGoto = page.goto.bind(page)
    page.goto = (async (...args: Parameters<Page['goto']>) => {
      logNavigationEvent('mcp-goto-started', { url: describeNavigationUrl(String(args[0])) })
      const response = await originalGoto(...args)
      await waitForPageContentReady(page, behavior)
      logNavigationEvent('mcp-goto-settled', { url: describeNavigationUrl(page.url()) })
      return response
    }) as Page['goto']
  }

  for (const page of context.pages())
    attach(page)
  context.on('page', attach)
}

export function findIdentityMismatches(
  expected: BrowserIdentityExpectation,
  actual: BrowserIdentityActual,
): string[] {
  const mismatches: string[] = []
  const compare = (label: string, expectedValue: unknown, actualValue: unknown) => {
    if (expectedValue !== undefined && JSON.stringify(expectedValue) !== JSON.stringify(actualValue))
      mismatches.push(`${label}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`)
  }

  compare('userAgent', expected.userAgent, actual.userAgent)
  compare('platform', expected.platform, actual.platform)
  compare('language', expected.language, actual.language)
  compare('languages', expected.languages, actual.languages)
  compare('timeZone', expected.timeZone, actual.timeZone)
  compare('screen', expected.screen, actual.screen)
  compare('devicePixelRatio', expected.devicePixelRatio, actual.devicePixelRatio)
  compare('hardwareConcurrency', expected.hardwareConcurrency, actual.hardwareConcurrency)
  compare('colorScheme', expected.colorScheme, actual.colorScheme)
  return mismatches
}

export async function verifyBrowserIdentity(
  context: BrowserContext,
  expected: BrowserIdentityExpectation | undefined,
): Promise<void> {
  if (!expected)
    return

  const page = context.pages()[0] ?? await context.newPage()
  const actual = await page.evaluate((): BrowserIdentityActual => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: [...navigator.languages],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'no-preference',
  }))
  const mismatches = findIdentityMismatches(expected, actual)

  console.error(`[lumi-playwright] browser identity verified: ${JSON.stringify(actual)}`)
  if (mismatches.length > 0)
    console.warn(`[lumi-playwright] browser identity mismatch: ${mismatches.join('; ')}`)
}

export async function createBrowserContext(
  config: LauncherConfig,
  dependencies: BrowserDependencies = defaultDependencies,
): Promise<BrowserContext> {
  await installPlugins(config.plugins, config.configDir, dependencies)

  const context = await dependencies.chromium.launchPersistentContext(config.userDataDir, {
    ...config.browser.launchOptions,
    channel: config.browser.channel,
    headless: config.browser.headless,
  })

  await context.addInitScript({ content: NAVIGATOR_WEBDRIVER_HARDENING })

  for (const scriptPath of config.initScripts)
    await context.addInitScript({ path: scriptPath })

  installNavigationReadinessPolicy(context, config.behavior)

  for (const setupModule of config.setupModules) {
    const imported = await dependencies.importModule(importSpecifier(setupModule, config.configDir))
    const setup = moduleCallable(imported, 'setup')
    await setup(context, config)
  }

  await verifyBrowserIdentity(context, config.identity)

  return context
}
