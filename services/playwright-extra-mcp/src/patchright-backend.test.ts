import type { BrowserBackendUnavailableError, BrowserContextLike } from './browser-contracts'
import type { PatchrightBackendDependencies } from './patchright-backend'

import { describe, expect, it, vi } from 'vitest'

import { PatchrightBackend } from './patchright-backend'

function settings() {
  return {
    browserName: 'chromium' as const,
    channel: 'chrome',
    headless: false,
    persistentContext: true,
    noViewport: true,
    profilePath: 'C:\\lumi\\data\\browser_profiles\\lumi',
    launchOptions: {},
  }
}

function backendHarness(importFailure?: Error) {
  const contextClose = vi.fn(async () => undefined)
  const context = {
    browser: () => ({ version: () => 'Chrome 140', close: vi.fn() }),
    close: contextClose,
    newPage: vi.fn(),
    pages: () => [],
    on: vi.fn(),
    once: vi.fn(),
    addInitScript: vi.fn(),
  } as BrowserContextLike
  const launchPersistentContext = vi.fn(async () => context)
  const release = vi.fn(async () => undefined)
  const dependencies: PatchrightBackendDependencies = {
    importPatchright: importFailure
      ? vi.fn(async () => {
          throw importFailure
        })
      : vi.fn(async () => ({
          chromium: {
            launch: vi.fn(),
            launchPersistentContext,
          },
        })),
    acquireProfileLease: vi.fn(async () => ({ release })),
    loadPackageVersion: vi.fn(async () => '1.61.1'),
  }
  return {
    backend: new PatchrightBackend(settings(), 'test-platform', dependencies),
    contextClose,
    dependencies,
    launchPersistentContext,
    release,
  }
}

describe('patchrightBackend lifecycle', () => {
  it('passes explicit headed persistent settings and profile to Patchright', async () => {
    const harness = backendHarness()

    await harness.backend.start()

    expect(harness.launchPersistentContext).toHaveBeenCalledWith(
      'C:\\lumi\\data\\browser_profiles\\lumi',
      expect.objectContaining({
        channel: 'chrome',
        headless: false,
        viewport: null,
      }),
    )
    expect(harness.dependencies.acquireProfileLease).toHaveBeenCalledWith(
      'C:\\lumi\\data\\browser_profiles\\lumi',
    )
  })

  it('releases context and profile lease when closed', async () => {
    const harness = backendHarness()
    await harness.backend.start()

    await harness.backend.close()

    expect(harness.contextClose).toHaveBeenCalledOnce()
    expect(harness.release).toHaveBeenCalledOnce()
  })

  it('reports a missing Patchright dependency with an actionable error', async () => {
    const harness = backendHarness(new Error('ERR_MODULE_NOT_FOUND'))

    await expect(harness.backend.start()).rejects.toMatchObject({
      name: 'BrowserBackendUnavailableError',
      message: expect.stringContaining('Install the `patchright` package'),
    } satisfies Partial<BrowserBackendUnavailableError>)
  })
})
