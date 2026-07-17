import type { BrowserIdentityExpectation, LauncherFileConfig } from '../config'

import { chromium } from 'playwright'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value`)
  return value
}

const outputPath = resolve(requiredOption('--output'))
const userDataDir = resolve(requiredOption('--user-data-dir'))
const temporaryProfile = await mkdtemp(join(tmpdir(), 'lumi-browser-identity-'))
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined

try {
  context = await chromium.launchPersistentContext(temporaryProfile, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  })
  const page = context.pages()[0] ?? await context.newPage()
  await page.waitForTimeout(500)
  const identity = await page.evaluate((): BrowserIdentityExpectation => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    languages: [...navigator.languages],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      colorDepth: screen.colorDepth,
      pixelDepth: screen.pixelDepth,
    },
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: navigator.hardwareConcurrency,
    colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'no-preference',
  }))
  const config: LauncherFileConfig = {
    userDataDir,
    browser: {
      channel: 'chrome',
      headless: false,
      launchOptions: {
        timezoneId: identity.timeZone,
        viewport: null,
        args: ['--start-maximized'],
      },
    },
    identity,
    behavior: {
      navigationReadyTimeoutMs: 15_000,
      postNavigationSettleMs: 350,
    },
    plugins: [{ module: 'puppeteer-extra-plugin-stealth' }],
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ outputPath, identity }, null, 2))
}
finally {
  await context?.close()
  await rm(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
