import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mineflayer = require('../../external-mcp/minecraft-mcp-server/node_modules/mineflayer')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] != null) {
    return process.argv[index + 1]
  }
  return fallback
}

const host = arg('host', 'localhost')
const port = Number(arg('port', '25565'))
const username = arg('username', 'LumiBotTest')
const version = arg('version', '1.20.1')
const auth = arg('auth', 'offline')
const timeoutMs = Number(arg('timeout', '30000'))

console.log('[mineflayer-test] connecting', {
  host,
  port,
  username,
  version,
  auth,
  timeoutMs,
})

const bot = mineflayer.createBot({
  host,
  port,
  username,
  version,
  auth,
})

let settled = false

function finish(code) {
  if (settled) {
    return
  }
  settled = true
  try {
    bot.quit('connection test finished')
  }
  catch {}
  setTimeout(() => process.exit(code), 300)
}

const timer = setTimeout(() => {
  console.error(`[mineflayer-test] timeout after ${timeoutMs}ms`)
  finish(2)
}, timeoutMs)

bot.once('login', () => {
  console.log('[mineflayer-test] login ok')
})

bot.once('spawn', () => {
  clearTimeout(timer)
  console.log('[mineflayer-test] spawn ok')
  console.log('[mineflayer-test] bot version:', bot.version)
  console.log('[mineflayer-test] position:', bot.entity?.position?.toString?.() ?? bot.entity?.position)
  bot.chat('LumiBotTest connected.')
  finish(0)
})

bot.on('kicked', (reason) => {
  clearTimeout(timer)
  console.error('[mineflayer-test] kicked:', typeof reason === 'string' ? reason : JSON.stringify(reason))
  finish(3)
})

bot.on('error', (error) => {
  clearTimeout(timer)
  console.error('[mineflayer-test] error:', error?.code ?? error?.name ?? 'UnknownError', error?.message ?? String(error))
})

bot.on('end', (reason) => {
  clearTimeout(timer)
  console.error('[mineflayer-test] end:', reason)
  finish(settled ? 0 : 4)
})
