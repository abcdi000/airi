#!/usr/bin/env node

import type {
  BrowserConsoleMessageLike,
  BrowserPageLike,
  BrowserRequestLike,
  BrowserResponseLike,
} from '../browser-contracts'

import { createBrowserContext, loadLauncherConfig } from '../index'

function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return url.origin === 'null' ? value : `${url.origin}${url.pathname}`
  }
  catch {
    return value
  }
}

function report(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), event, ...fields }))
}

function isRelevantRequest(request: BrowserRequestLike): boolean {
  return ['document', 'script', 'xhr', 'fetch'].includes(request.resourceType())
}

function describeConsole(message: BrowserConsoleMessageLike) {
  const location = message.location().url
  return {
    level: message.type(),
    text: message.text().slice(0, 1_000),
    source: location ? safeUrl(location) : undefined,
  }
}

function observePage(page: BrowserPageLike, captureConsole: boolean): void {
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      report('main-frame-navigated', { url: safeUrl(frame.url()) })
  })
  if (captureConsole)
    page.on('console', message => report('console', describeConsole(message)))
  page.on('pageerror', error => report('page-error', { message: error.message }))
  page.on('request', (request) => {
    if (isRelevantRequest(request))
      report('request', { resource: request.resourceType(), url: safeUrl(request.url()) })
  })
  page.on('response', (response: BrowserResponseLike) => {
    const request = response.request()
    if (isRelevantRequest(request)) {
      report('response', {
        resource: request.resourceType(),
        status: response.status(),
        url: safeUrl(response.url()),
      })
    }
  })
  page.on('requestfailed', request => report('request-failed', {
    resource: request.resourceType(),
    url: safeUrl(request.url()),
    failure: request.failure()?.errorText,
  }))
  page.on('close', () => report('page-closed', { url: safeUrl(page.url()) }))
}

const startedAt = performance.now()
const config = await loadLauncherConfig(process.argv.slice(2))
const observationMs = Number.parseInt(process.env.LUMI_FORENSICS_OBSERVATION_MS ?? '6000', 10)
const captureConsole = process.env.LUMI_FORENSICS_CAPTURE_CONSOLE !== '0'
const context = await createBrowserContext(config, {
  backend: 'playwright',
  requiredCapabilities: ['console'],
})
const page = context.pages()[0] ?? await context.newPage()

try {
  observePage(page, captureConsole)
  report('visit-started', { url: 'https://www.zhipin.com/', observationMs, captureConsole })
  await page.goto('https://www.zhipin.com/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(Number.isFinite(observationMs) ? observationMs : 6000)
  report('visit-finished', { url: safeUrl(page.url()), title: await page.title().catch(() => '') })
}
finally {
  await context.close()
}
