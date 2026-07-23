import type {
  BrowserBackend,
  BrowserBackendName,
  BrowserBackendRequest,
  BrowserLaunchSettings,
} from './browser-contracts'
import type { LauncherConfig } from './config'

import { BrowserBackendCompatibilityError } from './browser-contracts'
import { PatchrightBackend } from './patchright-backend'
import { PlaywrightBackend } from './playwright-backend'

export interface BrowserFactoryDependencies {
  createPatchright: (settings: BrowserLaunchSettings, platform?: string) => BrowserBackend
  createPlaywright: (settings: BrowserLaunchSettings, platform?: string) => BrowserBackend
  log: (message: string) => void
  warn: (message: string) => void
}

function backendSettings(config: LauncherConfig, backend: BrowserBackendName, request: BrowserBackendRequest): BrowserLaunchSettings {
  const configured = config.browser.backends[backend]
  return {
    ...configured,
    browserName: request.browserName ?? configured.browserName,
    profilePath: config.userDataDir,
  }
}

function selectedBackend(config: LauncherConfig, request: BrowserBackendRequest): BrowserBackendName {
  if (request.backend)
    return request.backend
  if (request.platform && config.browser.platformOverrides[request.platform])
    return config.browser.platformOverrides[request.platform]
  if (request.browserName === 'firefox' || request.browserName === 'webkit')
    return 'playwright'
  if (request.requiredCapabilities?.some(capability => capability === 'console' || capability === 'tracing'))
    return 'playwright'
  return config.browser.defaultBackend
}

export class BrowserFactory {
  constructor(
    private readonly config: LauncherConfig,
    private readonly dependencies: BrowserFactoryDependencies = {
      createPatchright: (settings, platform) => new PatchrightBackend(settings, platform),
      createPlaywright: (settings, platform) => new PlaywrightBackend(settings, config.configDir, config.plugins, platform),
      log: message => console.error(`[lumi-browser] ${message}`),
      warn: message => console.warn(`[lumi-browser] ${message}`),
    },
  ) {}

  private createBackend(name: BrowserBackendName, request: BrowserBackendRequest): BrowserBackend {
    const settings = backendSettings(this.config, name, request)
    return name === 'patchright'
      ? this.dependencies.createPatchright(settings, request.platform)
      : this.dependencies.createPlaywright(settings, request.platform)
  }

  /**
   * Selects and starts one Lumi browser backend.
   *
   * Use when:
   * - MCP needs its long-lived browser context
   * - A task or platform explicitly overrides the configured default
   *
   * Expects:
   * - Explicit task backend takes precedence over platform and global defaults
   * - Only compatibility errors are eligible for fallback
   *
   * Returns:
   * - A started backend with runtime diagnostics available
   */
  async create(request: BrowserBackendRequest = {}): Promise<BrowserBackend> {
    const selected = selectedBackend(this.config, request)
    this.dependencies.log(`Browser backend selected: ${selected}`)
    const backend = this.createBackend(selected, request)

    if (selected === 'patchright' && backendSettings(this.config, selected, request).headless) {
      this.dependencies.warn(
        'Patchright is running in headless mode. This is not Lumi\'s recommended persistent-browser configuration.',
      )
    }

    try {
      await backend.start()
      return backend
    }
    catch (error) {
      const fallback = this.config.browser.fallbackBackend
      if (
        !(error instanceof BrowserBackendCompatibilityError)
        || selected !== 'patchright'
        || fallback !== 'playwright'
      ) {
        throw error
      }

      const reason = error.message
      this.dependencies.warn(`Patchright compatibility failure; falling back to Playwright: ${reason}`)
      await backend.close()
      const fallbackBackend = this.createBackend(fallback, request)
      await fallbackBackend.start()
      const runtimeInfo = fallbackBackend.getRuntimeInfo()
      runtimeInfo.fallbackReason = reason
      return fallbackBackend
    }
  }
}
