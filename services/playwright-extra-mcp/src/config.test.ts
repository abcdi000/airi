import { describe, expect, it } from 'vitest'

import { loadLauncherConfig, parseCliArgs } from './config'

describe('playwright-extra MCP launcher config', () => {
  it('enables stealth and headed Chrome by default', async () => {
    const config = await loadLauncherConfig([], {}, 'C:\\lumi')

    expect(config.browser).toMatchObject({
      channel: 'chrome',
      headless: false,
    })
    expect(config.plugins).toEqual([
      { module: 'puppeteer-extra-plugin-stealth' },
    ])
    expect(config.behavior).toEqual({
      navigationReadyTimeoutMs: 15_000,
      postNavigationSettleMs: 350,
    })
    expect(config.userDataDir).toBe('C:\\lumi\\.playwright-mcp\\profile')
  })

  it('accepts a persistent profile and additional extension modules', async () => {
    const config = await loadLauncherConfig([
      '--user-data-dir',
      'C:\\profiles\\lumi',
      '--plugin',
      'playwright-extra-plugin-example',
      '--setup-module',
      '.\\setup.mjs',
    ], {}, 'C:\\lumi')

    expect(config.userDataDir).toBe('C:\\profiles\\lumi')
    expect(config.plugins.map(plugin => plugin.module)).toEqual([
      'puppeteer-extra-plugin-stealth',
      'playwright-extra-plugin-example',
    ])
    expect(config.setupModules).toEqual(['.\\setup.mjs'])
  })

  it('can explicitly disable stealth', async () => {
    const config = await loadLauncherConfig(['--no-stealth'], {}, 'C:\\lumi')
    expect(config.plugins).toEqual([])
  })

  it('rejects unknown arguments', () => {
    expect(() => parseCliArgs(['--mystery'])).toThrow('Unknown argument: --mystery')
  })
})
