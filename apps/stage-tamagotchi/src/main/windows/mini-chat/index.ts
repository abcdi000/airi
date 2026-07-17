import type { Rectangle } from 'electron'
import type { InferOutput } from 'valibot'

import type { I18n } from '../../libs/i18n'
import type { ServerChannel } from '../../services/airi/channel-server'
import type { McpStdioManager } from '../../services/airi/mcp-servers'
import type { WidgetsWindowManager } from '../widgets'

import { join, resolve } from 'node:path'

import clickDragPlugin from 'electron-click-drag-plugin'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { BrowserWindow, shell } from 'electron'
import { ipcMain } from 'electron'
import { isLinux } from 'std-env'
import { number, object, optional } from 'valibot'

import icon from '../../../../resources/icon.png?asset'

import { electronStartDraggingWindow } from '../../../shared/eventa'
import { baseUrl, getElectronMainDirname, load, withHashRoute } from '../../libs/electron/location'
import { createConfig } from '../../libs/electron/persistence'
import { createReusableWindow } from '../../libs/electron/window-manager'
import { transparentWindowConfig } from '../shared'
import { setupChatWindowElectronInvokes } from '../chat/rpc/index.electron'

const miniChatConfigSchema = object({
  x: optional(number()),
  y: optional(number()),
  width: optional(number()),
  height: optional(number()),
})

type MiniChatConfig = InferOutput<typeof miniChatConfigSchema>

export interface MiniChatWindowManager {
  getWindow: () => Promise<BrowserWindow>
  openWindow: () => Promise<void>
}

export function setupMiniChatWindowReusableFunc(params: {
  widgetsManager: WidgetsWindowManager
  serverChannel: ServerChannel
  mcpStdioManager: McpStdioManager
  i18n: I18n
}): MiniChatWindowManager {
  const {
    setup: setupConfig,
    get: getConfigRaw,
    update: updateConfig,
  } = createConfig('windows-mini-chat', 'config.json', miniChatConfigSchema, {
    default: { width: 420, height: 620 },
    autoHeal: true,
  })
  setupConfig()

  const getConfig = (): MiniChatConfig => getConfigRaw() ?? { width: 420, height: 620 }
  const rendererBase = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'))
  let persistBoundsTimer: ReturnType<typeof setTimeout> | undefined

  function persistBounds(bounds: Rectangle) {
    if (persistBoundsTimer)
      clearTimeout(persistBoundsTimer)
    persistBoundsTimer = setTimeout(() => {
      persistBoundsTimer = undefined
      updateConfig({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      })
    }, 350)
  }

  function persistBoundsNow(bounds: Rectangle) {
    if (persistBoundsTimer) {
      clearTimeout(persistBoundsTimer)
      persistBoundsTimer = undefined
    }
    updateConfig({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    })
  }

  const reusable = createReusableWindow(async () => {
    const config = getConfig()
    const window = new BrowserWindow({
      title: 'Lumi Chat Mini',
      width: config.width ?? 420,
      height: config.height ?? 620,
      minWidth: 320,
      minHeight: 420,
      resizable: true,
      thickFrame: true,
      x: config.x,
      y: config.y,
      show: false,
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

    await setupChatWindowElectronInvokes({
      window,
      widgetsManager: params.widgetsManager,
      serverChannel: params.serverChannel,
      mcpStdioManager: params.mcpStdioManager,
      i18n: params.i18n,
    })

    await load(window, withHashRoute(rendererBase, '/chat-mini'))

    if (!isLinux) {
      function handleStartDraggingWindow(_: unknown, options?: any) {
        if (options?.raw?.ipcMainEvent?.sender?.id !== window.webContents.id)
          return

        try {
          clickDragPlugin.startDrag(window.getNativeWindowHandle())
        }
        catch (error) {
          console.error(error)
        }
      }

      ipcMain.setMaxListeners(0)
      const { context } = createContext(ipcMain, window)
      const cleanUpWindowDraggingInvokeHandler = defineInvokeHandler(context, electronStartDraggingWindow, handleStartDraggingWindow)

      window.on('closed', () => {
        cleanUpWindowDraggingInvokeHandler()
      })
    }

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
