import process from 'node:process'

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { errorMessageFrom } from '@moeru/std'

/**
 * Starts electron-vite with Lumi runtime arguments forwarded to Electron.
 *
 * Use when:
 * - Developing the standalone Lumi Server Manager window.
 * - Starting the Manager-owned server as part of a local integration test.
 *
 * Expects:
 * - The script runs from the stage-tamagotchi package through its package script.
 *
 * Returns:
 * - The exit status emitted by electron-vite.
 *
 * Call stack:
 *
 * runLumiDesktopDev
 *   -> electron-vite dev
 *     -> Electron main process
 *       -> setupLumiServerManager
 */
async function runLumiDesktopDev() {
  const role = process.argv[2]
  if (role !== 'manager')
    throw new Error(`Unsupported Lumi development role: ${role ?? '(missing)'}`)

  const electronArguments = [
    '--lumi-server-manager',
    ...(process.argv.includes('--start-server') ? ['--start-server'] : []),
  ]
  const electronViteEntry = fileURLToPath(new URL('./cli.js', import.meta.resolve('electron-vite')))
  // electron-vite owns the `--` separator and converts the remaining values into
  // Electron process arguments. Environment-only injection is overwritten by its CLI.
  const child = spawn(process.execPath, [electronViteEntry, 'dev', '--', ...electronArguments], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal)
        resolve(1)
      else
        resolve(code ?? 1)
    })
  })
  process.exitCode = exitCode
}

void runLumiDesktopDev().catch((error) => {
  process.stderr.write(`${errorMessageFrom(error) ?? 'Failed to start Lumi development mode'}\n`)
  process.exitCode = 1
})
