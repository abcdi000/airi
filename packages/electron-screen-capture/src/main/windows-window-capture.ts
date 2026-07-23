import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

interface CaptureWorkerResponse {
  id: string
  ok: boolean
  data?: string
  error?: string
}

interface PendingCapture {
  worker: ChildProcessWithoutNullStreams
  resolve: (dataUrl: string) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

const captureWorkerScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LumiWindowCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool IsWindow(IntPtr hwnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
}
'@

while (($line = [Console]::In.ReadLine()) -ne $null) {
  $requestId = ''
  $bitmap = $null
  $graphics = $null
  $stream = $null
  try {
    $request = $line | ConvertFrom-Json
    $requestId = [string]$request.id
    $handleValue = [Convert]::ToInt64([string]$request.handle, 10)
    $hwnd = [IntPtr]::new($handleValue)
    if (-not [LumiWindowCapture]::IsWindow($hwnd)) {
      throw 'The selected window handle is no longer valid.'
    }

    $rect = New-Object LumiWindowCapture+RECT
    $rectSize = [Runtime.InteropServices.Marshal]::SizeOf([type][LumiWindowCapture+RECT])
    $dwmResult = [LumiWindowCapture]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, $rectSize)
    if ($dwmResult -ne 0 -and -not [LumiWindowCapture]::GetWindowRect($hwnd, [ref]$rect)) {
      throw "Unable to read the selected window bounds: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }

    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
      throw "The selected window has invalid bounds."
    }

    $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
      # PW_RENDERFULLCONTENT requests the complete target window without
      # broadening the capture to any surrounding desktop content.
      if (-not [LumiWindowCapture]::PrintWindow($hwnd, $hdc, 2)) {
        throw "PrintWindow failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
      }
    }
    finally {
      $graphics.ReleaseHdc($hdc)
    }

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $response = @{
      id = $requestId
      ok = $true
      data = [Convert]::ToBase64String($stream.ToArray())
    }
  }
  catch {
    $response = @{
      id = $requestId
      ok = $false
      error = $_.Exception.Message
    }
  }
  finally {
    if ($stream) { $stream.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
  }

  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress))
}
`

let captureWorker: ChildProcessWithoutNullStreams | undefined
let requestSequence = 0
const pendingCaptures = new Map<string, PendingCapture>()

/**
 * Extracts a native HWND from an Electron desktop-capture source ID.
 *
 * Before:
 * - `window:123456:0`
 *
 * After:
 * - `123456`
 */
export function windowHandleFromSourceId(sourceId: string): string | undefined {
  const match = /^window:(\d+):\d+$/.exec(sourceId)
  if (!match)
    return undefined

  const handle = BigInt(match[1])
  if (handle <= 0n || handle > 9223372036854775807n)
    return undefined

  return handle.toString()
}

function rejectPendingCaptures(message: string) {
  for (const pending of pendingCaptures.values()) {
    clearTimeout(pending.timeout)
    pending.reject(new Error(message))
  }
  pendingCaptures.clear()
}

function rejectWorkerCaptures(worker: ChildProcessWithoutNullStreams, message: string) {
  for (const [requestId, pending] of pendingCaptures) {
    if (pending.worker !== worker)
      continue
    clearTimeout(pending.timeout)
    pending.reject(new Error(message))
    pendingCaptures.delete(requestId)
  }
}

function handleWorkerResponse(line: string) {
  let response: CaptureWorkerResponse
  try {
    response = JSON.parse(line) as CaptureWorkerResponse
  }
  catch {
    return
  }

  const pending = pendingCaptures.get(response.id)
  if (!pending)
    return

  pendingCaptures.delete(response.id)
  clearTimeout(pending.timeout)
  if (!response.ok) {
    pending.reject(new Error(response.error || 'Native window capture failed.'))
    return
  }

  const base64 = response.data?.replace(/\s/g, '')
  if (!base64 || base64.length > 64 * 1024 * 1024 || !/^[a-z0-9+/]+={0,2}$/i.test(base64)) {
    pending.reject(new Error('Native window capture returned an invalid PNG payload.'))
    return
  }
  pending.resolve(`data:image/png;base64,${base64}`)
}

function ensureCaptureWorker(): ChildProcessWithoutNullStreams {
  if (captureWorker && !captureWorker.killed)
    return captureWorker

  const executable = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe'
  const encodedScript = Buffer.from(captureWorkerScript, 'utf16le').toString('base64')
  const worker = spawn(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encodedScript,
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  captureWorker = worker

  const lines = createInterface({ input: worker.stdout, crlfDelay: Number.POSITIVE_INFINITY })
  lines.on('line', handleWorkerResponse)
  worker.once('error', (error) => {
    if (captureWorker === worker)
      captureWorker = undefined
    rejectWorkerCaptures(worker, `Native window capture worker failed: ${error.message}`)
  })
  worker.once('close', (code) => {
    lines.close()
    if (captureWorker === worker)
      captureWorker = undefined
    rejectWorkerCaptures(worker, `Native window capture worker exited with code ${code}.`)
  })

  return worker
}

/** Stops the reusable Windows capture worker during application shutdown. */
export function disposeWindowsWindowCapture(): void {
  const worker = captureWorker
  captureWorker = undefined
  rejectPendingCaptures('Native window capture stopped because the application is closing.')
  worker?.kill()
}

/**
 * Captures one Windows HWND through a reusable PrintWindow worker.
 *
 * Use when:
 * - Electron reports `Source is not capturable` for an enumerated window
 * - A single-window image must be preserved instead of silently using a screen
 *
 * Expects:
 * - Windows PowerShell and the .NET Framework System.Drawing assembly
 * - An Electron source ID in `window:HWND:*` form
 *
 * Returns:
 * - A PNG data URL containing only the selected window
 */
export async function captureWindowsWindow(sourceId: string): Promise<string> {
  const handle = windowHandleFromSourceId(sourceId)
  if (!handle)
    throw new Error(`Invalid Windows capture source ID: ${sourceId}`)

  const worker = ensureCaptureWorker()
  const requestId = String(++requestSequence)
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCaptures.delete(requestId)
      if (captureWorker === worker)
        captureWorker = undefined
      worker.kill()
      reject(new Error('Native window capture timed out after 8 seconds.'))
    }, 8000)
    pendingCaptures.set(requestId, { worker, resolve, reject, timeout })
    worker.stdin.write(`${JSON.stringify({ id: requestId, handle })}\n`, 'utf8', (error) => {
      if (!error)
        return
      const pending = pendingCaptures.get(requestId)
      if (!pending)
        return
      pendingCaptures.delete(requestId)
      clearTimeout(pending.timeout)
      pending.reject(error)
    })
  })
}
