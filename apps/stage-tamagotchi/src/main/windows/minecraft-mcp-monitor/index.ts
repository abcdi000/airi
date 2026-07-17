import type { BrowserWindow, Rectangle } from 'electron'
import type { InferOutput } from 'valibot'

import type { I18n } from '../../libs/i18n'
import type { ServerChannel } from '../../services/airi/channel-server'
import type { McpStdioManager } from '../../services/airi/mcp-servers'

import { join, resolve } from 'node:path'

import { createContext } from '@moeru/eventa/adapters/electron/main'
import { BrowserWindow as ElectronBrowserWindow, ipcMain, shell } from 'electron'
import { number, object, optional } from 'valibot'

import icon from '../../../../resources/icon.png?asset'

import { baseUrl, getElectronMainDirname, load, withHashRoute } from '../../libs/electron/location'
import { createConfig } from '../../libs/electron/persistence'
import { createReusableWindow } from '../../libs/electron/window-manager'
import { createMcpServersService } from '../../services/airi/mcp-servers'
import { setupBaseWindowElectronInvokes, transparentWindowConfig } from '../shared/window'

const monitorConfigSchema = object({
  x: optional(number()),
  y: optional(number()),
  width: optional(number()),
  height: optional(number()),
})

type MonitorConfig = InferOutput<typeof monitorConfigSchema>

export interface MinecraftMcpMonitorWindowManager {
  getWindow: () => Promise<BrowserWindow>
  openWindow: () => Promise<void>
}

export function setupMinecraftMcpMonitorWindowReusableFunc(params: {
  serverChannel: ServerChannel
  mcpStdioManager: McpStdioManager
  i18n: I18n
}): MinecraftMcpMonitorWindowManager {
  const {
    setup: setupConfig,
    get: getConfigRaw,
    update: updateConfig,
  } = createConfig('windows-minecraft-mcp-monitor', 'config.json', monitorConfigSchema, {
    default: { width: 430, height: 620 },
    autoHeal: true,
  })
  setupConfig()

  const getConfig = (): MonitorConfig => getConfigRaw() ?? { width: 430, height: 620 }
  const rendererBase = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'))
  let persistBoundsTimer: ReturnType<typeof setTimeout> | undefined

  function persistBounds(bounds: Rectangle) {
    if (persistBoundsTimer)
      clearTimeout(persistBoundsTimer)
    persistBoundsTimer = setTimeout(() => {
      persistBoundsTimer = undefined
      updateConfig(bounds)
    }, 350)
  }

  function persistBoundsNow(bounds: Rectangle) {
    if (persistBoundsTimer) {
      clearTimeout(persistBoundsTimer)
      persistBoundsTimer = undefined
    }
    updateConfig(bounds)
  }

  const reusable = createReusableWindow(async () => {
    const config = getConfig()
    const window = new ElectronBrowserWindow({
      title: 'Minecraft MCP Monitor',
      width: config.width ?? 430,
      height: config.height ?? 620,
      minWidth: 360,
      minHeight: 300,
      x: config.x,
      y: config.y,
      show: false,
      resizable: true,
      thickFrame: true,
      icon,
      webPreferences: {
        preload: join(getElectronMainDirname(), '../preload/index.mjs'),
        sandbox: false,
      },
      ...transparentWindowConfig(),
    })

    window.setAlwaysOnTop(true, 'screen-saver', 1)
    window.on('resize', () => persistBounds(window.getBounds()))
    window.on('move', () => persistBounds(window.getBounds()))
    window.on('close', () => persistBoundsNow(window.getBounds()))
    window.on('ready-to-show', () => window.show())
    window.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })

    ipcMain.setMaxListeners(0)
    const { context } = createContext(ipcMain, window)
    await setupBaseWindowElectronInvokes({
      context,
      window,
      i18n: params.i18n,
      serverChannel: params.serverChannel,
    })
    createMcpServersService({ context, manager: params.mcpStdioManager })

    await load(window, withHashRoute(rendererBase, '/minecraft-mcp-monitor'))

    return window
  })

  async function openWindow() {
    const window = await reusable.getWindow()
    if (window.isMinimized())
      window.restore()
    window.show()
    window.focus()
  }

  return {
    getWindow: reusable.getWindow,
    openWindow,
  }
}
