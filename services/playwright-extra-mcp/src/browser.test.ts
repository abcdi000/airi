import type { BrowserContext, Page } from 'playwright'

import { describe, expect, it, vi } from 'vitest'

import { createBrowserContext, findIdentityMismatches, installNavigationForensics, installNavigationReadinessPolicy, installPlugins } from './browser'
import type { LauncherConfig } from './config'

function launcherConfig(): LauncherConfig {
  return {
    configDir: 'C:\\lumi',
    userDataDir: 'C:\\profiles\\lumi',
    browser: {
      channel: 'chrome',
      headless: false,
      launchOptions: { locale: 'zh-CN' },
    },
    plugins: [{ module: 'stealth', options: { enabledEvasions: ['navigator.webdriver'] } }],
    behavior: {
      navigationReadyTimeoutMs: 15_000,
      postNavigationSettleMs: 350,
    },
    initScripts: [],
    setupModules: [],
    mcp: {},
  }
}

describe('playwright-extra browser integration', () => {
  it('installs each configured plugin through playwright-extra', async () => {
    const use = vi.fn()
    const factory = vi.fn(() => ({ name: 'stealth' }))
    const dependencies = {
      chromium: {
        use,
        launchPersistentContext: vi.fn(),
      },
      importModule: vi.fn(async () => ({ default: factory })),
    }

    await installPlugins(launcherConfig().plugins, 'C:\\lumi', dependencies)

    expect(factory).toHaveBeenCalledWith({ enabledEvasions: ['navigator.webdriver'] })
    expect(use).toHaveBeenCalledWith({ name: 'stealth' })
  })

  it('launches a persistent Chrome context after plugins are installed', async () => {
    const addInitScript = vi.fn()
    const page = {
      url: () => 'about:blank',
      goto: vi.fn(),
      waitForLoadState: vi.fn(),
      waitForFunction: vi.fn(),
      waitForTimeout: vi.fn(),
      mainFrame: vi.fn(),
      on: vi.fn(),
    }
    const context = {
      addInitScript,
      pages: () => [page],
      on: vi.fn(),
    } as unknown as BrowserContext
    const launchPersistentContext = vi.fn(async () => context)
    const dependencies = {
      chromium: {
        use: vi.fn(),
        launchPersistentContext,
      },
      importModule: vi.fn(async () => ({ default: () => ({ name: 'stealth' }) })),
    }

    await createBrowserContext(launcherConfig(), dependencies)

    expect(launchPersistentContext).toHaveBeenCalledWith('C:\\profiles\\lumi', {
      locale: 'zh-CN',
      channel: 'chrome',
      headless: false,
    })
    expect(addInitScript).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('delete prototype.webdriver'),
    }))
  })

  it('waits for page readiness after every navigation', async () => {
    const page = {
      url: () => 'about:blank',
      goto: vi.fn(async () => 'response'),
      waitForLoadState: vi.fn(async () => undefined),
      waitForFunction: vi.fn(async () => undefined),
      waitForTimeout: vi.fn(async () => undefined),
      mainFrame: vi.fn(),
      on: vi.fn(),
    }
    const context = {
      pages: () => [page],
      on: vi.fn(),
    } as unknown as BrowserContext

    installNavigationReadinessPolicy(context, launcherConfig().behavior)
    await (page.goto as (url: string) => Promise<unknown>)('https://example.com')

    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 15_000 })
    expect(page.waitForFunction).toHaveBeenCalled()
    expect(page.waitForTimeout).toHaveBeenCalledWith(350)
  })

  it('records main-frame navigation without inspecting page content', () => {
    const handlers = new Map<string, (value?: unknown) => void>()
    const page = {
      url: () => 'https://example.com/first?private=value',
      mainFrame: () => frame,
      on: vi.fn((event: string, handler: (value?: unknown) => void) => handlers.set(event, handler)),
    }
    const frame = { url: () => 'https://example.com/next?private=value' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    installNavigationForensics(page as unknown as Page)
    handlers.get('framenavigated')?.(frame)

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"to":"https://example.com/next"'))
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('private=value'))
    error.mockRestore()
  })

  it('reports identity drift without changing the browser fingerprint', () => {
    expect(findIdentityMismatches(
      { language: 'zh-CN', timeZone: 'Asia/Shanghai' },
      {
        userAgent: 'Chrome',
        platform: 'Win32',
        language: 'zh-CN',
        languages: ['zh-CN', 'zh'],
        timeZone: 'Asia/Shanghai',
        screen: undefined,
        devicePixelRatio: 1,
        hardwareConcurrency: 8,
        colorScheme: 'dark',
      },
    )).toEqual([])
  })
})
