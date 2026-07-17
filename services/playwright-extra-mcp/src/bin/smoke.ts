import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const serviceDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const profileDir = resolve(serviceDir, '.tmp', 'smoke-profile')
const runnerPath = resolve(serviceDir, 'dist', 'bin', 'run.mjs')

await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
await mkdir(profileDir, { recursive: true })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    runnerPath,
    '--user-data-dir',
    profileDir,
    '--channel',
    'chrome',
    '--headless',
  ],
  stderr: 'pipe',
})

transport.stderr?.on('data', chunk => process.stderr.write(chunk))

const client = new Client({ name: 'lumi-playwright-extra-smoke', version: '1.0.0' })

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const toolNames = new Set(tools.tools.map(tool => tool.name))
  if (!toolNames.has('browser_navigate') || !toolNames.has('browser_evaluate'))
    throw new Error('Official Playwright MCP browser tools were not registered')

  await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: 'data:text/html,<title>Lumi stealth smoke</title><h1>ready</h1>',
    },
  })

  const evaluation = await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      function: `() => ({
        webdriver: navigator.webdriver ?? null,
        hasWebdriverProperty: 'webdriver' in navigator,
        userAgent: navigator.userAgent,
      })`,
    },
  })

  console.log(JSON.stringify({
    toolCount: tools.tools.length,
    evaluation: evaluation.content,
  }, null, 2))
}
finally {
  await client.close()
  await rm(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
