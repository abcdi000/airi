import type { BrowserBackend, BrowserContextLike } from './browser-contracts'
import type { LauncherConfig } from './config'

import process from 'node:process'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createConnection } from '@playwright/mcp'

import { configureBrowserContext } from './browser'
import { BrowserFactory } from './browser-factory'
import { loadLauncherConfig } from './config'

export {
  configureBrowserContext,
  createBrowserContext,
  findIdentityMismatches,
  installNavigationForensics,
  installNavigationReadinessPolicy,
  verifyBrowserIdentity,
  waitForPageContentReady,
} from './browser'
export {
  BrowserBackendCompatibilityError,
  BrowserBackendError,
  BrowserBackendUnavailableError,
  BrowserProfileInUseError,
} from './browser-contracts'
export type {
  BrowserBackend,
  BrowserBackendName,
  BrowserBackendRequest,
  BrowserCapability,
  BrowserContextLike,
  BrowserLaunchSettings,
  BrowserName,
  BrowserPageLike,
  BrowserRuntimeInfo,
} from './browser-contracts'
export { BrowserFactory } from './browser-factory'
export { loadLauncherConfig, parseCliArgs } from './config'
export type {
  BrowserBackendFileConfig,
  BrowserBehaviorConfig,
  BrowserIdentityExpectation,
  LauncherConfig,
  LauncherFileConfig,
  PluginSpec,
} from './config'
export { PatchrightBackend } from './patchright-backend'
export { PlaywrightBackend } from './playwright-backend'

function formatRuntimeInfo(backend: BrowserBackend): string {
  const info = backend.getRuntimeInfo()
  return JSON.stringify({
    backend: info.backend,
    backend_version: info.backendVersion,
    browser_name: info.browserName,
    browser_version: info.browserVersion,
    channel: info.channel,
    headless: info.headless,
    persistent_context: info.persistentContext,
    profile_path: info.profilePath,
    platform: info.platform,
    fallback_reason: info.fallbackReason,
  })
}

export async function runPlaywrightExtraMcp(config: LauncherConfig): Promise<void> {
  let backendPromise: Promise<BrowserBackend> | undefined
  let closePromise: Promise<void> | undefined
  let configuredContext: BrowserContextLike | undefined
  let configuredContextPromise: Promise<void> | undefined
  const factory = new BrowserFactory(config)

  const getBackend = (): Promise<BrowserBackend> => {
    if (!backendPromise) {
      closePromise = undefined
      backendPromise = factory.create(config.startupRequest).catch((error) => {
        backendPromise = undefined
        throw error
      })
    }
    return backendPromise
  }

  const getContext = async (): Promise<BrowserContextLike> => {
    const backend = await getBackend()
    const context = await backend.getContext()
    if (configuredContext !== context) {
      configuredContext = context
      const configurePromise = configureBrowserContext(context, config).then(() => {
        console.error(`[lumi-browser] Browser session started: ${formatRuntimeInfo(backend)}`)
      })
      configuredContextPromise = configurePromise
      context.once('close', () => {
        if (configuredContext !== context)
          return
        configuredContext = undefined
        configuredContextPromise = undefined
        console.error('[lumi-browser] Browser context closed; the next browser tool call will restart it.')
      })
      try {
        await configurePromise
      }
      catch (error) {
        if (configuredContext === context) {
          configuredContext = undefined
          configuredContextPromise = undefined
        }
        throw error
      }
    }
    else {
      await configuredContextPromise
    }
    return context
  }
  type McpContextGetter = NonNullable<Parameters<typeof createConnection>[1]>
  const server = await createConnection(config.mcp, getContext as unknown as McpContextGetter)
  const transport = new StdioServerTransport()

  const closeBackend = (): Promise<void> => {
    if (!closePromise) {
      closePromise = (async () => {
        const pendingBackend = backendPromise
        backendPromise = undefined
        configuredContext = undefined
        configuredContextPromise = undefined
        if (!pendingBackend)
          return
        try {
          await (await pendingBackend).close()
        }
        catch (error) {
          const message = String(error)
          console.error(`[lumi-browser] browser shutdown warning: ${message}`)
        }
      })()
    }
    return closePromise
  }

  transport.onclose = () => {
    void closeBackend()
  }
  process.stdin.once('end', () => {
    void closeBackend()
  })
  process.once('SIGINT', () => {
    void closeBackend().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void closeBackend().finally(() => process.exit(0))
  })

  await server.connect(transport)
}

export async function runFromCommandLine(args: string[] = process.argv.slice(2)): Promise<void> {
  const config = await loadLauncherConfig(args)
  console.error(
    `[lumi-browser] configured default=${config.browser.defaultBackend} fallback=${config.browser.fallbackBackend ?? 'disabled'} profile=${config.userDataDir}`,
  )
  await runPlaywrightExtraMcp(config)
}
