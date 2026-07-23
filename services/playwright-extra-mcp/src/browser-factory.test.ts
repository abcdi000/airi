import type {
  BrowserBackend,
  BrowserBackendName,
  BrowserContextLike,
  BrowserLaunchSettings,
  BrowserRuntimeInfo,
} from './browser-contracts'
import type { LauncherConfig } from './config'

import { describe, expect, it, vi } from 'vitest'

import {
  BrowserBackendCompatibilityError,
  BrowserBackendError,
} from './browser-contracts'
import { BrowserFactory } from './browser-factory'
import { loadLauncherConfig } from './config'

class FakeBackend implements BrowserBackend {
  readonly start = vi.fn(async () => {
    if (this.startError)
      throw this.startError
  })

  readonly close = vi.fn(async () => undefined)

  private readonly runtimeInfo: BrowserRuntimeInfo

  constructor(
    readonly name: BrowserBackendName,
    settings: BrowserLaunchSettings,
    platform?: string,
    private readonly startError?: Error,
  ) {
    this.runtimeInfo = {
      backend: name,
      backendVersion: 'test',
      browserName: settings.browserName,
      browserVersion: 'test',
      channel: settings.channel,
      headless: settings.headless,
      persistentContext: settings.persistentContext,
      profilePath: settings.profilePath,
      platform,
    }
  }

  async newPage(): Promise<never> {
    throw new Error('Not used by factory tests')
  }

  async getContext(): Promise<BrowserContextLike> {
    throw new Error('Not used by factory tests')
  }

  getRuntimeInfo(): BrowserRuntimeInfo {
    return this.runtimeInfo
  }
}

async function testConfig(transform?: (config: LauncherConfig) => void): Promise<LauncherConfig> {
  const config = await loadLauncherConfig([], {}, 'C:\\lumi')
  transform?.(config)
  return config
}

function factoryHarness(
  config: LauncherConfig,
  errors: Partial<Record<BrowserBackendName, Error>> = {},
) {
  const created: FakeBackend[] = []
  const log = vi.fn()
  const warn = vi.fn()
  const create = (name: BrowserBackendName, settings: BrowserLaunchSettings, platform?: string) => {
    const backend = new FakeBackend(name, settings, platform, errors[name])
    created.push(backend)
    return backend
  }
  const factory = new BrowserFactory(config, {
    createPatchright: (settings, platform) => create('patchright', settings, platform),
    createPlaywright: (settings, platform) => create('playwright', settings, platform),
    log,
    warn,
  })
  return { created, factory, log, warn }
}

describe('browserFactory backend policy', () => {
  it('selects Patchright from the default configuration', async () => {
    const harness = factoryHarness(await testConfig())

    const backend = await harness.factory.create()

    expect(backend.name).toBe('patchright')
    expect(harness.log).toHaveBeenCalledWith('Browser backend selected: patchright')
  })

  it('selects Playwright when a task explicitly requests it', async () => {
    const harness = factoryHarness(await testConfig())

    const backend = await harness.factory.create({ backend: 'playwright' })

    expect(backend.name).toBe('playwright')
  })

  it('lets a platform override replace the default backend', async () => {
    const config = await testConfig((value) => {
      value.browser.platformOverrides.xiaohongshu = 'playwright'
    })
    const harness = factoryHarness(config)

    const backend = await harness.factory.create({ platform: 'xiaohongshu' })

    expect(backend.name).toBe('playwright')
    expect(backend.getRuntimeInfo().platform).toBe('xiaohongshu')
  })

  it('uses Playwright for Firefox and Playwright-only capabilities', async () => {
    const firefoxHarness = factoryHarness(await testConfig())
    const consoleHarness = factoryHarness(await testConfig())

    expect((await firefoxHarness.factory.create({ browserName: 'firefox' })).name).toBe('playwright')
    expect((await consoleHarness.factory.create({ requiredCapabilities: ['console'] })).name).toBe('playwright')
  })

  it('falls back only after a Patchright compatibility failure and records the reason', async () => {
    const failure = new BrowserBackendCompatibilityError('unsupported browser protocol')
    const harness = factoryHarness(await testConfig(), { patchright: failure })

    const backend = await harness.factory.create()

    expect(backend.name).toBe('playwright')
    expect(backend.getRuntimeInfo().fallbackReason).toBe(failure.message)
    expect(harness.created[0]?.close).toHaveBeenCalledOnce()
    expect(harness.warn).toHaveBeenCalledWith(
      `Patchright compatibility failure; falling back to Playwright: ${failure.message}`,
    )
  })

  it('does not fallback for network, captcha, page, or business failures', async () => {
    for (const message of ['network timeout', 'captcha required', 'page returned 500', 'element not found']) {
      const failure = new BrowserBackendError(message)
      const harness = factoryHarness(await testConfig(), { patchright: failure })

      await expect(harness.factory.create()).rejects.toBe(failure)
      expect(harness.created).toHaveLength(1)
    }
  })
})
