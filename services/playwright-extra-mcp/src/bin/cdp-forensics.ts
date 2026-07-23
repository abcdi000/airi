#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'

import { connectPlaywrightOverCdp } from '../playwright-backend'

const chromePath = process.env.LUMI_CDP_CHROME_PATH
const profileDir = process.env.LUMI_CDP_USER_DATA_DIR
const port = Number.parseInt(process.env.LUMI_CDP_PORT ?? '19222', 10)
const observationMs = Number.parseInt(process.env.LUMI_CDP_OBSERVATION_MS ?? '8000', 10)

if (!chromePath || !profileDir)
  throw new Error('LUMI_CDP_CHROME_PATH and LUMI_CDP_USER_DATA_DIR are required')
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('LUMI_CDP_PORT must be a valid TCP port')

await access(chromePath)
const startedAt = performance.now()
const report = (event: string, fields: Record<string, unknown> = {}) => {
  console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), event, ...fields }))
}
const safeUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.origin === 'null' ? value : `${url.origin}${url.pathname}`
  }
  catch {
    return value
  }
}

const chrome = spawn(chromePath, [
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore', windowsHide: false })

try {
  const endpoint = `http://127.0.0.1:${port}`
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok)
        break
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 250))
    if (attempt === 29)
      throw new Error('Chrome CDP endpoint did not become available')
  }

  const browser = await connectPlaywrightOverCdp(endpoint)
  const context = browser.contexts()[0]
  if (!context)
    throw new Error('Chrome CDP endpoint did not expose a browser context')
  const page = context.pages()[0] ?? await context.newPage()
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      report('main-frame-navigated', { url: safeUrl(frame.url()) })
  })
  page.on('requestfailed', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      report('main-document-request-failed', {
        url: safeUrl(request.url()),
        failure: request.failure()?.errorText,
      })
    }
  })

  report('visit-started', { url: 'https://www.zhipin.com/', observationMs })
  await page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(Number.isFinite(observationMs) ? observationMs : 8000)
  report('visit-finished', { url: safeUrl(page.url()), title: await page.title().catch(() => '') })
  await browser.close()
}
finally {
  chrome.kill()
}
