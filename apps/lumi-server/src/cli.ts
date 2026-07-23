#!/usr/bin/env node

import process from 'node:process'

import { pathToFileURL } from 'node:url'

import { errorMessageFrom } from '@moeru/std'
import { cac } from 'cac'

import { startLumiServerProcess } from './app'
import { initializeLumiServerConfig, loadLumiServerConfig } from './config'

/**
 * Creates the standalone Lumi Server command line runner.
 *
 * Call stack:
 *
 * createLumiServerCli
 *   -> {@link loadLumiServerConfig}
 *     -> {@link startLumiServerProcess}
 *       -> createLumiNetworkServer
 */
export function createLumiServerCli() {
  const cli = cac('lumi-server')
  cli.command('init', 'Create a private starter configuration')
    .option('--config <path>', 'Configuration file', { default: './lumi-server.json' })
    .action(async ({ config }: { config: string }) => {
      const path = await initializeLumiServerConfig(config)
      process.stdout.write(`Created Lumi Server config: ${path}\n`)
    })
  cli.command('start', 'Start the authoritative Lumi Online process')
    .option('--config <path>', 'Configuration file', { default: './lumi-server.json' })
    .action(async ({ config }: { config: string }) => {
      const loaded = await loadLumiServerConfig(config)
      const server = await startLumiServerProcess(loaded)
      process.stdout.write(`Lumi Server listening at ${loaded.publicBaseURL}\n`)
      let stopping: Promise<void> | undefined
      const stop = () => {
        stopping ??= server.stop().then(() => {
          process.stdout.write('Lumi Server stopped cleanly.\n')
        })
        return stopping
      }
      const stopFromSignal = () => {
        void stop().then(
          () => process.exit(0),
          (error) => {
            process.stderr.write(`${errorMessageFrom(error) ?? 'Lumi Server shutdown failed'}\n`)
            process.exit(1)
          },
        )
      }
      process.once('SIGINT', stopFromSignal)
      process.once('SIGTERM', stopFromSignal)
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        if (chunk.split(/\r?\n/).some(command => command.trim().toLowerCase() === 'shutdown'))
          stopFromSignal()
      })
    })
  cli.help()
  return cli
}

async function main() {
  const cli = createLumiServerCli()
  cli.parse(process.argv, { run: false })
  if (!cli.matchedCommand) {
    cli.outputHelp()
    process.exitCode = 1
    return
  }
  await cli.runMatchedCommand()
}

function isExecutedAsMainModule() {
  const entryFile = process.argv[1]
  return entryFile ? import.meta.url === pathToFileURL(entryFile).href : false
}

if (isExecutedAsMainModule()) {
  void main().catch((error) => {
    process.stderr.write(`${errorMessageFrom(error) ?? 'Lumi Server failed'}\n`)
    process.exit(1)
  })
}
