import type { BrowserContext } from 'playwright'
import type { LauncherConfig } from './config'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createConnection } from '@playwright/mcp'

import { createBrowserContext } from './browser'
import { loadLauncherConfig } from './config'

export {
  createBrowserContext,
  findIdentityMismatches,
  installNavigationReadinessPolicy,
  installPlugins,
  verifyBrowserIdentity,
  waitForPageContentReady,
} from './browser'
export { loadLauncherConfig, parseCliArgs } from './config'
export type { BrowserBehaviorConfig, BrowserIdentityExpectation, LauncherConfig, LauncherFileConfig, PluginSpec } from './config'

export async function runPlaywrightExtraMcp(config: LauncherConfig): Promise<void> {
  let contextPromise: Promise<BrowserContext> | undefined
  let contextClosePromise: Promise<void> | undefined

  const getContext = async (): Promise<BrowserContext> => {
    if (!contextPromise) {
      contextClosePromise = undefined
      contextPromise = createBrowserContext(config)
      void contextPromise.then((context) => {
        context.once('close', () => {
          contextPromise = undefined
        })
      }, () => {
        contextPromise = undefined
      })
    }
    return contextPromise
  }

  const server = await createConnection(config.mcp, getContext)
  const transport = new StdioServerTransport()

  const closeContext = (): Promise<void> => {
    if (!contextClosePromise) {
      contextClosePromise = (async () => {
        const pendingContext = contextPromise
        contextPromise = undefined
        if (pendingContext) {
          try {
            const context = await pendingContext
            await context.close()
          }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[lumi-playwright] browser shutdown warning: ${message}`)
          }
        }
      })()
    }
    return contextClosePromise
  }

  transport.onclose = () => {
    void closeContext()
  }
  process.stdin.once('end', () => {
    void closeContext()
  })
  process.once('SIGINT', () => {
    void closeContext().finally(() => process.exit(0))
  })
  process.once('SIGTERM', () => {
    void closeContext().finally(() => process.exit(0))
  })

  await server.connect(transport)
}

export async function runFromCommandLine(args: string[] = process.argv.slice(2)): Promise<void> {
  const config = await loadLauncherConfig(args)
  console.error(`[lumi-playwright] playwright-extra enabled: ${config.plugins.map(plugin => plugin.module).join(', ') || 'none'}`)
  console.error(`[lumi-playwright] browser channel=${config.browser.channel} headless=${config.browser.headless} profile=${config.userDataDir}`)
  await runPlaywrightExtraMcp(config)
}
