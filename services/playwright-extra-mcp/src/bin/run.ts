#!/usr/bin/env node

import { runFromCommandLine } from '../index'

runFromCommandLine().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[lumi-playwright] fatal: ${message}`)
  process.exitCode = 1
})
