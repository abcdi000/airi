import type { BrowserContextLike, BrowserPageLike } from './browser-contracts'

import { describe, expect, it, vi } from 'vitest'

import {
  findIdentityMismatches,
  installNavigationForensics,
  installNavigationReadinessPolicy,
} from './browser'

const behavior = {
  navigationReadyTimeoutMs: 15_000,
  postNavigationSettleMs: 350,
}

function navigationPage(): BrowserPageLike {
  const frame = { url: () => 'about:blank' }
  return {
    url: () => 'about:blank',
    title: async () => '',
    goto: vi.fn(async () => 'response'),
    waitForLoadState: vi.fn(async () => undefined),
    waitForFunction: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    evaluate: vi.fn(),
    mainFrame: () => frame,
    on: vi.fn(),
  } as BrowserPageLike
}

function navigationContext(page: BrowserPageLike): BrowserContextLike {
  return {
    addInitScript: vi.fn(),
    browser: () => null,
    close: vi.fn(),
    newPage: vi.fn(async () => page),
    pages: () => [page],
    on: vi.fn(),
    once: vi.fn(),
  } as BrowserContextLike
}

describe('browser-independent page policies', () => {
  it('waits for page readiness after every navigation', async () => {
    const page = navigationPage()
    const context = navigationContext(page)

    installNavigationReadinessPolicy(context, behavior)
    await page.goto('https://example.com')

    expect(page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 15_000 })
    expect(page.waitForFunction).toHaveBeenCalled()
    expect(page.waitForTimeout).toHaveBeenCalledWith(350)
  })

  it('records main-frame navigation without logging private query data', () => {
    const handlers = new Map<string, (value?: unknown) => void>()
    const frame = { url: () => 'https://example.com/next?private=value' }
    const page = {
      ...navigationPage(),
      url: () => 'https://example.com/first?private=value',
      mainFrame: () => frame,
      on: vi.fn((event: string, handler: (value?: unknown) => void) => {
        handlers.set(event, handler)
        return page
      }),
    } as BrowserPageLike
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    installNavigationForensics(page)
    handlers.get('framenavigated')?.(frame)

    expect(error).toHaveBeenCalledWith(expect.stringContaining('"to":"https://example.com/next"'))
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('private=value'))
    error.mockRestore()
  })

  it('reports identity drift without changing browser identity', () => {
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
