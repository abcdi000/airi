import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { ElectronWindowBounds, ElectronWindowLifecycleState } from '../../../shared/eventa'

import { defineInvokeHandler } from '@moeru/eventa'
import { bounds, startLoopGetBounds } from '@proj-airi/electron-eventa'
import { createRendererLoop, safeClose } from '@proj-airi/electron-vueuse/main'

import {
  electron,
  electronGetWindowLifecycleState,
  electronWindowAnimateBounds,
  electronWindowClose,
  electronWindowLifecycleChanged,
  electronWindowSetAlwaysOnTop,
  electronWindowStopBoundsAnimation,
} from '../../../shared/eventa'
import { onAppBeforeQuit, onAppWindowAllClosed } from '../../libs/bootkit/lifecycle'
import { resizeWindowByDelta } from '../../windows/shared/window'

export function createWindowService(params: { context: ReturnType<typeof createContext>['context'], window: BrowserWindow }) {
  let boundsAnimationTimer: ReturnType<typeof setInterval> | undefined

  function stopBoundsAnimation() {
    if (!boundsAnimationTimer)
      return

    clearInterval(boundsAnimationTimer)
    boundsAnimationTimer = undefined
  }

  function easeOutCubic(value: number) {
    return 1 - (1 - value) ** 3
  }

  function animateWindowBounds(target: ElectronWindowBounds, durationMs = 150) {
    stopBoundsAnimation()

    const from = params.window.getBounds()
    const duration = Math.max(0, Math.min(260, Math.round(durationMs)))
    if (duration <= 0) {
      params.window.setBounds(target, false)
      return Promise.resolve()
    }

    const startedAt = Date.now()
    let lastSerialized = ''

    return new Promise<void>((resolve) => {
      boundsAnimationTimer = setInterval(() => {
        const progress = Math.min(1, (Date.now() - startedAt) / duration)
        const eased = easeOutCubic(progress)
        const next = {
          x: Math.round(from.x + (target.x - from.x) * eased),
          y: Math.round(from.y + (target.y - from.y) * eased),
          width: Math.round(from.width + (target.width - from.width) * eased),
          height: Math.round(from.height + (target.height - from.height) * eased),
        }
        const serialized = `${next.x},${next.y},${next.width},${next.height}`
        if (serialized !== lastSerialized) {
          params.window.setBounds(next, false)
          lastSerialized = serialized
        }

        if (progress >= 1) {
          stopBoundsAnimation()
          params.window.setBounds(target, false)
          resolve()
        }
      }, 16)
    })
  }

  function getWindowLifecycleState(reason: ElectronWindowLifecycleState['reason']): ElectronWindowLifecycleState {
    return {
      focused: params.window.isFocused(),
      minimized: params.window.isMinimized(),
      reason,
      updatedAt: Date.now(),
      visible: params.window.isVisible(),
    }
  }

  function emitWindowLifecycle(reason: ElectronWindowLifecycleState['reason']) {
    params.context.emit(electronWindowLifecycleChanged, getWindowLifecycleState(reason))
  }

  const { start, stop } = createRendererLoop({
    window: params.window,
    run: () => {
      params.context.emit(bounds, params.window.getBounds())
    },
  })

  onAppWindowAllClosed(() => stop())
  onAppBeforeQuit(() => stop())
  defineInvokeHandler(params.context, startLoopGetBounds, () => start())
  defineInvokeHandler(params.context, electronGetWindowLifecycleState, (_, options) => {
    if (params.window.webContents.id === options?.raw.ipcMainEvent.sender.id)
      return getWindowLifecycleState('snapshot')
  })

  params.window.on('show', () => emitWindowLifecycle('show'))
  params.window.on('hide', () => emitWindowLifecycle('hide'))
  params.window.on('minimize', () => emitWindowLifecycle('minimize'))
  params.window.on('restore', () => emitWindowLifecycle('restore'))
  params.window.on('focus', () => emitWindowLifecycle('focus'))
  params.window.on('blur', () => emitWindowLifecycle('blur'))

  defineInvokeHandler(params.context, electron.window.getBounds, (_, options) => {
    if (params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      return params.window.getBounds()
    }

    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    }
  })

  defineInvokeHandler(params.context, electron.window.setBounds, (newBounds, options) => {
    if (newBounds && params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      stopBoundsAnimation()
      params.window.setBounds(newBounds[0], newBounds[1])
    }
  })

  defineInvokeHandler(params.context, electronWindowAnimateBounds, (payload, options) => {
    if (payload && params.window.webContents.id === options?.raw.ipcMainEvent.sender.id)
      return animateWindowBounds(payload[0], payload[1])
  })

  defineInvokeHandler(params.context, electronWindowStopBoundsAnimation, (_, options) => {
    if (params.window.webContents.id === options?.raw.ipcMainEvent.sender.id)
      stopBoundsAnimation()
  })

  defineInvokeHandler(params.context, electron.window.setIgnoreMouseEvents, (opts, options) => {
    if (opts && params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      params.window.setIgnoreMouseEvents(...opts)
    }
  })

  defineInvokeHandler(params.context, electronWindowSetAlwaysOnTop, (flag, options) => {
    if (params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      if (flag) {
        params.window.setAlwaysOnTop(true, 'screen-saver', 1)
      }
      else {
        params.window.setAlwaysOnTop(false)
      }
    }
  })

  defineInvokeHandler(params.context, electron.window.setVibrancy, (vibrancy, options) => {
    if (vibrancy && params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      params.window.setVibrancy(vibrancy[0])
    }
  })

  defineInvokeHandler(params.context, electron.window.setBackgroundMaterial, (backgroundMaterial, options) => {
    if (backgroundMaterial && params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      params.window.setBackgroundMaterial(backgroundMaterial[0])
    }
  })

  defineInvokeHandler(params.context, electron.window.resize, (payload, options) => {
    if (!payload || params.window.webContents.id !== options?.raw.ipcMainEvent.sender.id) {
      return
    }

    resizeWindowByDelta({
      window: params.window,
      deltaX: payload.deltaX,
      deltaY: payload.deltaY,
      direction: payload.direction,
    })
  })

  defineInvokeHandler(params.context, electronWindowClose, (_, options) => {
    if (params.window.webContents.id === options?.raw.ipcMainEvent.sender.id) {
      safeClose(params.window)
    }
  })
}
