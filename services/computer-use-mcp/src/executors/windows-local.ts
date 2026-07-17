import type {
  ClickActionInput,
  ComputerUseConfig,
  DesktopExecutor,
  DisplayInfo,
  ExecutionTarget,
  ExecutorActionResult,
  FocusAppActionInput,
  ForegroundContext,
  ObserveWindowsRequest,
  PermissionInfo,
  PointerTracePoint,
  ProcessObservation,
  ProcessObservationRequest,
  PressKeysActionInput,
  ScrollActionInput,
  ScreenshotArtifact,
  ScreenshotRequest,
  TypeTextActionInput,
  WaitActionInput,
  WindowObservation,
} from '../types'

import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { platform } from 'node:process'

import { sanitizeFileSegment } from '../utils/process'
import { runWindowsHelper } from './windows-helper'

type NativeBounds = { x: number, y: number, width: number, height: number }
type NativeWindowObservation = Omit<WindowObservation, 'windows'> & {
  windows: Array<{
    id: string
    appName: string
    title?: string
    bounds?: NativeBounds
    ownerPid?: number
    layer?: number
    isOnScreen?: boolean
  }>
}

function executionTarget(config: ComputerUseConfig): ExecutionTarget {
  return {
    mode: 'local-windowed',
    transport: 'local',
    hostName: hostname(),
    sessionTag: config.sessionTag,
    isolated: false,
    tainted: false,
    note: 'local Windows UI Automation + SendInput executor',
  }
}

function result(notes: string[], target: ExecutionTarget): ExecutorActionResult {
  return {
    performed: true,
    backend: 'windows-local',
    notes,
    executionTarget: target,
  }
}

async function ensureWindows() {
  if (platform !== 'win32')
    throw new Error('windows-local executor requires Windows')
}

export function createWindowsLocalExecutor(config: ComputerUseConfig): DesktopExecutor {
  const target = executionTarget(config)

  const observeWindows = async (request: ObserveWindowsRequest): Promise<WindowObservation> => {
    await ensureWindows()
    return await runWindowsHelper<NativeWindowObservation>(config, 'observe-windows', request)
  }

  const foreground = async (): Promise<ForegroundContext> => {
    await ensureWindows()
    const value = await runWindowsHelper<ForegroundContext>(config, 'foreground')
    return {
      ...value,
      platform,
      unavailableReason: value.available ? undefined : 'no foreground Windows window is available',
    }
  }

  return {
    kind: 'windows-local',
    describe: () => ({
      kind: 'windows-local',
      notes: [
        'window observation uses Win32 window enumeration',
        'grounding uses Windows UI Automation when available',
        'screenshots use the Windows desktop capture surface',
        'input injection uses Win32 SendInput against the current user session',
      ],
    }),
    getExecutionTarget: async () => target,
    getForegroundContext: foreground,
    getDisplayInfo: async (): Promise<DisplayInfo> => {
      await ensureWindows()
      const info = await runWindowsHelper<Omit<DisplayInfo, 'platform'>>(config, 'display-info')
      return { ...info, platform }
    },
    getPermissionInfo: async (): Promise<PermissionInfo> => ({
      screenRecording: {
        status: 'granted',
        target: 'current Windows desktop session',
        checkedBy: 'Windows desktop capture helper',
        note: 'Windows does not require a per-app screen-recording consent for the current desktop session.',
      },
      accessibility: {
        status: 'granted',
        target: 'current Windows desktop session',
        checkedBy: 'Windows UI Automation',
        note: 'Elevated windows can still reject automation because of Windows integrity-level isolation.',
      },
      automationToSystemEvents: {
        status: 'granted',
        target: 'current Windows desktop session',
        checkedBy: 'SendInput',
        note: 'Input is limited to the active interactive user session.',
      },
    }),
    observeWindows,
    listProcesses: async (request: ProcessObservationRequest): Promise<ProcessObservation> => {
      await ensureWindows()
      return await runWindowsHelper<ProcessObservation>(config, 'list-processes', request)
    },
    takeScreenshot: async (request: ScreenshotRequest): Promise<ScreenshotArtifact> => {
      await ensureWindows()
      const label = sanitizeFileSegment(request.label, 'desktop')
      const path = join(config.screenshotsDir, `${Date.now()}-${label}.png`)
      const captured = await runWindowsHelper<{ path: string, width: number, height: number }>(config, 'screenshot', { outputPath: path })
      const dataBase64 = (await readFile(captured.path)).toString('base64')
      return {
        dataBase64,
        mimeType: 'image/png',
        path: captured.path,
        width: captured.width,
        height: captured.height,
        capturedAt: new Date().toISOString(),
        executionTargetMode: target.mode,
        sourceHostName: target.hostName,
        sourceSessionTag: target.sessionTag,
      }
    },
    openApp: async (input) => {
      await ensureWindows()
      await runWindowsHelper(config, 'open-app', input)
      return result([`opened Windows app ${input.app}`], target)
    },
    focusApp: async (input: FocusAppActionInput) => {
      await ensureWindows()
      const focused = await runWindowsHelper<{ foreground?: { appName?: string, title?: string } }>(config, 'focus-app', input)
      const label = focused.foreground?.appName || input.app
      return result([`focused and verified Windows app ${label}`], target)
    },
    click: async (input: ClickActionInput & { pointerTrace: PointerTracePoint[] }) => {
      await ensureWindows()
      await runWindowsHelper(config, 'click', input)
      return { ...result(['clicked on the local Windows desktop'], target), pointerTrace: input.pointerTrace }
    },
    typeText: async (input: TypeTextActionInput) => {
      await ensureWindows()
      const typed = await runWindowsHelper<{ foreground?: { appName?: string, title?: string }, submitted?: boolean }>(config, 'type-text', input)
      const label = typed.foreground?.appName || input.targetApp || 'the local Windows desktop'
      return result([
        `injected text into verified foreground app ${label}`,
        typed.submitted ? 'Enter was injected; delivery was not independently verified' : 'text was not submitted',
      ], target)
    },
    pressKeys: async (input: PressKeysActionInput) => {
      await ensureWindows()
      if (input.keys.length === 0)
        throw new Error('press_keys requires at least one key')
      const pressed = await runWindowsHelper<{ foreground?: { appName?: string, title?: string } }>(config, 'press-keys', input)
      const label = pressed.foreground?.appName || input.targetApp || 'the local Windows desktop'
      return result([`pressed keys ${input.keys.join('+')} in verified foreground app ${label}`], target)
    },
    scroll: async (input: ScrollActionInput) => {
      await ensureWindows()
      const context = await foreground()
      const x = input.x ?? context.windowBounds?.x
      const y = input.y ?? context.windowBounds?.y
      if (x == null || y == null)
        throw new Error('scroll requires a current foreground window or explicit x/y coordinates')
      await runWindowsHelper(config, 'scroll', { ...input, x, y })
      return result(['scrolled on the local Windows desktop'], target)
    },
    wait: async (input: WaitActionInput) => {
      await new Promise(resolve => setTimeout(resolve, Math.max(input.durationMs, 0)))
      return result(['waited on the local Windows desktop'], target)
    },
  }
}
