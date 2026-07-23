import { describe, expect, it } from 'vitest'

import { loadLauncherConfig, parseCliArgs } from './config'

describe('lumi browser launcher config', () => {
  it('selects headed persistent Patchright by default', async () => {
    const config = await loadLauncherConfig([], {}, 'C:\\lumi')

    expect(config.browser.defaultBackend).toBe('patchright')
    expect(config.browser.fallbackBackend).toBe('playwright')
    expect(config.browser.backends.patchright).toMatchObject({
      browserName: 'chromium',
      channel: 'chrome',
      headless: false,
      persistentContext: true,
      noViewport: true,
    })
    expect(config.plugins).toEqual([
      { module: 'puppeteer-extra-plugin-stealth' },
    ])
    expect(config.behavior).toEqual({
      navigationReadyTimeoutMs: 15_000,
      postNavigationSettleMs: 350,
    })
    expect(config.userDataDir).toBe('C:\\lumi\\data\\browser_profiles\\lumi')
  })

  it('accepts task backend, profile, and extension module overrides', async () => {
    const config = await loadLauncherConfig([
      '--backend',
      'playwright',
      '--user-data-dir',
      'C:\\profiles\\lumi',
      '--plugin',
      'playwright-extra-plugin-example',
      '--setup-module',
      '.\\setup.mjs',
    ], {}, 'C:\\lumi')

    expect(config.startupRequest.backend).toBe('playwright')
    expect(config.userDataDir).toBe('C:\\profiles\\lumi')
    expect(config.plugins.map(plugin => plugin.module)).toEqual([
      'puppeteer-extra-plugin-stealth',
      'playwright-extra-plugin-example',
    ])
    expect(config.setupModules).toEqual(['.\\setup.mjs'])
  })

  it('keeps legacy profile environment compatibility', async () => {
    const config = await loadLauncherConfig([], {
      LUMI_PLAYWRIGHT_USER_DATA_DIR: 'C:\\profiles\\existing-lumi',
    }, 'C:\\lumi')

    expect(config.userDataDir).toBe('C:\\profiles\\existing-lumi')
  })

  it('does not silently override explicit Patchright headless mode', async () => {
    const config = await loadLauncherConfig([], {
      LUMI_PATCHRIGHT_HEADLESS: 'true',
    }, 'C:\\lumi')

    expect(config.browser.backends.patchright.headless).toBe(true)
  })

  it('rejects unknown arguments', () => {
    expect(() => parseCliArgs(['--mystery'])).toThrow('Unknown argument: --mystery')
  })
})
