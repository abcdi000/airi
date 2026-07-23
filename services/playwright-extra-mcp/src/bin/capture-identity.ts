import type { BrowserIdentityExpectation, LauncherFileConfig } from '../config'

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { PatchrightBackend } from '../patchright-backend'

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
const backend = new PatchrightBackend({
  browserName: 'chromium',
  channel: 'chrome',
  headless: false,
  persistentContext: true,
  noViewport: true,
  profilePath: temporaryProfile,
  launchOptions: {
    args: ['--start-maximized'],
  },
})

try {
  const context = await backend.getContext()
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
      defaultBackend: 'patchright',
      fallbackBackend: 'playwright',
      patchright: {
        channel: 'chrome',
        headless: false,
        persistentContext: true,
        noViewport: true,
        launchOptions: {
          timezoneId: identity.timeZone,
          args: ['--start-maximized'],
        },
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
  await backend.close()
  await rm(temporaryProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
