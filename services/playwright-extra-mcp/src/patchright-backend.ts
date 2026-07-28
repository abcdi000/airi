import type { BackendDependencies, BrowserTypeLike } from './backend-support'
import type { BrowserLaunchSettings } from './browser-contracts'

import { BaseBrowserBackend, defaultBackendDependencies } from './backend-support'
import {
  BrowserBackendCompatibilityError,
  BrowserBackendError,
  BrowserBackendUnavailableError,
} from './browser-contracts'

interface PatchrightModule {
  chromium: BrowserTypeLike
}

export interface PatchrightBackendDependencies extends BackendDependencies {
  importPatchright: () => Promise<PatchrightModule>
}

const defaultDependencies: PatchrightBackendDependencies = {
  ...defaultBackendDependencies,
  importPatchright: () => import('patchright') as unknown as Promise<PatchrightModule>,
}

function isCompatibilityLaunchFailure(message: string): boolean {
  return [
    /executable .*doesn'?t exist/i,
    /browser.*not (?:found|supported|installed)/i,
    /failed to launch/i,
    /browser closed/i,
    /unsupported.*(?:channel|protocol|option)/i,
    /protocol error/i,
  ].some(pattern => pattern.test(message))
}

export class PatchrightBackend extends BaseBrowserBackend {
  readonly name = 'patchright' as const

  constructor(
    settings: BrowserLaunchSettings,
    platform?: string,
    private readonly patchrightDependencies: PatchrightBackendDependencies = defaultDependencies,
  ) {
    super(settings, platform, patchrightDependencies)
  }

  protected async startInternal(): Promise<void> {
    if (this.settings.browserName !== 'chromium') {
      throw new BrowserBackendCompatibilityError(
        `Patchright only supports Chromium; requested ${this.settings.browserName}.`,
      )
    }

    let module: PatchrightModule
    try {
      module = await this.patchrightDependencies.importPatchright()
    }
    catch (error) {
      throw new BrowserBackendUnavailableError(
        'Patchright is not installed or could not be loaded. Install the `patchright` package or enable the Playwright fallback.',
        { cause: error },
      )
    }

    await this.acquireProfile()
    try {
      this.attachContext(await this.openContext(module.chromium))
    }
    catch (error) {
      const message = String(error)
      if (isCompatibilityLaunchFailure(message)) {
        throw new BrowserBackendCompatibilityError(
          `Patchright could not start a compatible browser: ${message}`,
          { cause: error },
        )
      }
      throw new BrowserBackendError(`Patchright browser startup failed: ${message}`, { cause: error })
    }

    const version = await this.patchrightDependencies.loadPackageVersion('patchright')
    this.setRuntimeInfo('patchright', version)
  }
}
