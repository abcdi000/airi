import type { BackendDependencies, BrowserTypeLike } from './backend-support'
import type { BrowserContextLike, BrowserLaunchSettings } from './browser-contracts'
import type { PluginSpec } from './config'

import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { BaseBrowserBackend, defaultBackendDependencies } from './backend-support'
import { BrowserBackendError, BrowserBackendUnavailableError } from './browser-contracts'

export interface PlaywrightCdpBrowserLike {
  close: () => Promise<void>
  contexts: () => BrowserContextLike[]
}

interface PlaywrightChromiumLike extends BrowserTypeLike {
  connectOverCDP: (endpoint: string) => Promise<PlaywrightCdpBrowserLike>
}

interface PlaywrightModule {
  chromium: PlaywrightChromiumLike
  firefox: BrowserTypeLike
  webkit: BrowserTypeLike
}

interface PlaywrightExtraChromium extends BrowserTypeLike {
  use: (plugin: unknown) => PlaywrightExtraChromium
}

interface PlaywrightExtraModule {
  chromium: PlaywrightExtraChromium
}

type ImportedModule = Record<string, unknown>

export interface PlaywrightBackendDependencies extends BackendDependencies {
  importModule: (specifier: string) => Promise<ImportedModule>
  importPlaywright: () => Promise<PlaywrightModule>
  importPlaywrightExtra: () => Promise<PlaywrightExtraModule>
}

const defaultDependencies: PlaywrightBackendDependencies = {
  ...defaultBackendDependencies,
  importModule: specifier => import(specifier) as Promise<ImportedModule>,
  importPlaywright: () => import('playwright') as unknown as Promise<PlaywrightModule>,
  importPlaywrightExtra: () => import('playwright-extra') as unknown as Promise<PlaywrightExtraModule>,
}

function importSpecifier(specifier: string, configDir: string): string {
  if (specifier.startsWith('.') || isAbsolute(specifier))
    return pathToFileURL(resolve(configDir, specifier)).href
  return specifier
}

function moduleCallable(module: ImportedModule, exportName: string): (...args: unknown[]) => unknown {
  const candidate = module[exportName] ?? module.default
  if (typeof candidate !== 'function')
    throw new TypeError(`Module does not export a callable ${exportName} or default function`)
  return candidate as (...args: unknown[]) => unknown
}

/**
 * Connects a diagnostic command to an existing Chromium CDP endpoint.
 *
 * Use when:
 * - Console or protocol diagnostics require Playwright explicitly
 *
 * Expects:
 * - `endpoint` is a trusted local CDP endpoint
 *
 * Returns:
 * - A Playwright-backed browser connection
 */
export async function connectPlaywrightOverCdp(endpoint: string): Promise<PlaywrightCdpBrowserLike> {
  let playwright: PlaywrightModule
  try {
    playwright = await defaultDependencies.importPlaywright()
  }
  catch (error) {
    throw new BrowserBackendUnavailableError(
      'Playwright is required for CDP diagnostics but could not be loaded.',
      { cause: error },
    )
  }
  return await playwright.chromium.connectOverCDP(endpoint)
}

export class PlaywrightBackend extends BaseBrowserBackend {
  readonly name = 'playwright' as const

  constructor(
    settings: BrowserLaunchSettings,
    private readonly configDir: string,
    private readonly plugins: PluginSpec[],
    platform?: string,
    private readonly playwrightDependencies: PlaywrightBackendDependencies = defaultDependencies,
  ) {
    super(settings, platform, playwrightDependencies)
  }

  private async installPlugins(chromium: PlaywrightExtraChromium): Promise<void> {
    for (const spec of this.plugins) {
      const imported = await this.playwrightDependencies.importModule(importSpecifier(spec.module, this.configDir))
      const createPlugin = moduleCallable(imported, 'createPlugin')
      chromium.use(createPlugin(spec.options ?? {}))
    }
  }

  protected async startInternal(): Promise<void> {
    let browserType: BrowserTypeLike
    try {
      if (this.settings.browserName === 'chromium') {
        const extra = await this.playwrightDependencies.importPlaywrightExtra()
        await this.installPlugins(extra.chromium)
        browserType = extra.chromium
      }
      else {
        const playwright = await this.playwrightDependencies.importPlaywright()
        browserType = playwright[this.settings.browserName]
      }
    }
    catch (error) {
      throw new BrowserBackendUnavailableError(
        'Playwright is not installed or its browser driver could not be loaded.',
        { cause: error },
      )
    }

    await this.acquireProfile()
    try {
      this.context = await this.openContext(browserType)
    }
    catch (error) {
      const message = String(error)
      throw new BrowserBackendError(`Playwright browser startup failed: ${message}`, { cause: error })
    }

    const version = await this.playwrightDependencies.loadPackageVersion('playwright')
    this.setRuntimeInfo('playwright', version)
  }
}
