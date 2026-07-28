import type {
  BrowserContextLike,
  BrowserInstanceLike,
  BrowserLaunchSettings,
  BrowserPageLike,
  BrowserRuntimeInfo,
} from './browser-contracts'
import type { BrowserProfileLease } from './profile-lease'

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { BrowserBackendError } from './browser-contracts'
import { acquireBrowserProfileLease } from './profile-lease'

export interface BrowserTypeLike {
  launch: (options: Record<string, unknown>) => Promise<BrowserInstanceWithContext>
  launchPersistentContext: (profilePath: string, options: Record<string, unknown>) => Promise<BrowserContextLike>
}

export interface BrowserInstanceWithContext extends BrowserInstanceLike {
  newContext: (options: Record<string, unknown>) => Promise<BrowserContextLike>
}

export interface BackendDependencies {
  acquireProfileLease: typeof acquireBrowserProfileLease
  loadPackageVersion: (packageName: string) => Promise<string>
}

export const defaultBackendDependencies: BackendDependencies = {
  acquireProfileLease: acquireBrowserProfileLease,
  loadPackageVersion: async (packageName) => {
    const require = createRequire(import.meta.url)
    const packagePath = require.resolve(`${packageName}/package.json`)
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: string }
    return packageJson.version ?? 'unknown'
  },
}

export function launchContextOptions(settings: BrowserLaunchSettings): Record<string, unknown> {
  return {
    ...settings.launchOptions,
    channel: settings.channel || undefined,
    headless: settings.headless,
    viewport: settings.noViewport ? null : settings.launchOptions.viewport,
  }
}

export abstract class BaseBrowserBackend {
  protected context: BrowserContextLike | undefined
  protected browser: BrowserInstanceWithContext | undefined
  protected profileLease: BrowserProfileLease | undefined
  protected runtimeInfo: BrowserRuntimeInfo | undefined
  protected startPromise: Promise<void> | undefined
  protected closePromise: Promise<void> | undefined
  private contextCleanupPromise: Promise<void> | undefined

  protected constructor(
    protected readonly settings: BrowserLaunchSettings,
    protected readonly platform: string | undefined,
    protected readonly dependencies: BackendDependencies,
  ) {}

  protected abstract startInternal(): Promise<void>

  start(): Promise<void> {
    this.startPromise ??= (async () => {
      await this.contextCleanupPromise
      this.contextCleanupPromise = undefined
      await this.startInternal()
    })().catch(async (error) => {
      this.startPromise = undefined
      await this.releaseResources()
      throw error
    })
    return this.startPromise
  }

  async getContext(): Promise<BrowserContextLike> {
    await this.start()
    if (!this.context)
      throw new BrowserBackendError('Browser backend started without a context.')
    return this.context
  }

  async newPage(): Promise<BrowserPageLike> {
    return await (await this.getContext()).newPage()
  }

  getRuntimeInfo(): BrowserRuntimeInfo {
    if (!this.runtimeInfo)
      throw new BrowserBackendError('Browser backend runtime information is unavailable before start.')
    return this.runtimeInfo
  }

  protected async acquireProfile(): Promise<void> {
    if (this.settings.persistentContext)
      this.profileLease = await this.dependencies.acquireProfileLease(this.settings.profilePath)
  }

  protected async openContext(browserType: BrowserTypeLike): Promise<BrowserContextLike> {
    const options = launchContextOptions(this.settings)
    if (this.settings.persistentContext)
      return await browserType.launchPersistentContext(this.settings.profilePath, options)

    this.browser = await browserType.launch(options)
    return await this.browser.newContext(options)
  }

  /**
   * Tracks a newly opened context and invalidates the backend if Chromium closes it.
   *
   * Use when:
   * - A concrete backend has opened its persistent or temporary context
   * - The MCP `browser_close` tool or a user may close the visible browser window
   *
   * Expects:
   * - The context belongs to the currently acquired profile lease
   *
   * Returns:
   * - Nothing; subsequent {@link getContext} calls reopen the configured backend
   */
  protected attachContext(context: BrowserContextLike): void {
    this.context = context
    context.once('close', () => {
      if (this.context !== context)
        return

      const browser = this.browser
      const lease = this.profileLease
      this.context = undefined
      this.browser = undefined
      this.profileLease = undefined
      this.runtimeInfo = undefined
      this.startPromise = undefined

      // NOTICE:
      // A Playwright MCP browser_close call and a user closing the headed Chrome window both
      // close the context without calling BrowserBackend.close(). The old implementation kept
      // returning that dead context forever. Wait for its profile lock to be released before
      // reopening so the persistent Lumi profile is never opened concurrently.
      // Removal condition: the upstream MCP owns a restart-aware browser lifecycle.
      const cleanupPromise = (async () => {
        try {
          await browser?.close()
        }
        finally {
          await lease?.release()
        }
      })()
      const trackedCleanup = cleanupPromise.catch(() => undefined)
      this.contextCleanupPromise = trackedCleanup
      void trackedCleanup.then(() => {
        if (this.contextCleanupPromise === trackedCleanup)
          this.contextCleanupPromise = undefined
      })
    })
  }

  protected setRuntimeInfo(backend: BrowserRuntimeInfo['backend'], backendVersion: string): void {
    this.runtimeInfo = {
      backend,
      backendVersion,
      browserName: this.settings.browserName,
      browserVersion: this.context?.browser()?.version() ?? this.browser?.version() ?? 'unknown',
      channel: this.settings.channel,
      headless: this.settings.headless,
      persistentContext: this.settings.persistentContext,
      profilePath: this.settings.profilePath,
      platform: this.platform,
    }
  }

  private async releaseResources(): Promise<void> {
    await this.contextCleanupPromise
    this.contextCleanupPromise = undefined
    const context = this.context
    const browser = this.browser
    const lease = this.profileLease
    this.context = undefined
    this.browser = undefined
    this.profileLease = undefined

    try {
      await context?.close()
    }
    finally {
      try {
        await browser?.close()
      }
      finally {
        await lease?.release()
      }
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.releaseResources().finally(() => {
      this.startPromise = undefined
    })
    return this.closePromise
  }
}
