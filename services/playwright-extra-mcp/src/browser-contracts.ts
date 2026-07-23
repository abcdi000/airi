export type BrowserBackendName = 'patchright' | 'playwright'
export type BrowserName = 'chromium' | 'firefox' | 'webkit'
export type BrowserCapability = 'console' | 'tracing'

export interface BrowserFrameLike {
  url: () => string
}

export interface BrowserRequestLike {
  frame: () => BrowserFrameLike
  isNavigationRequest: () => boolean
  resourceType: () => string
  url: () => string
  failure: () => { errorText?: string } | null
}

export interface BrowserResponseLike {
  frame: () => BrowserFrameLike
  request: () => BrowserRequestLike
  status: () => number
  url: () => string
}

export interface BrowserConsoleMessageLike {
  location: () => { url: string }
  text: () => string
  type: () => string
}

export interface BrowserPageLike {
  url: () => string
  title: () => Promise<string>
  mainFrame: () => BrowserFrameLike
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>
  waitForLoadState: (state: 'domcontentloaded', options: { timeout: number }) => Promise<unknown>
  waitForFunction: (pageFunction: () => boolean, argument: undefined, options: { timeout: number }) => Promise<unknown>
  waitForTimeout: (timeout: number) => Promise<unknown>
  evaluate: <Result>(pageFunction: () => Result | Promise<Result>) => Promise<Result>
  on: {
    (event: 'framenavigated', listener: (frame: BrowserFrameLike) => void): BrowserPageLike
    (event: 'requestfailed', listener: (request: BrowserRequestLike) => void): BrowserPageLike
    (event: 'response', listener: (response: BrowserResponseLike) => void): BrowserPageLike
    (event: 'request', listener: (request: BrowserRequestLike) => void): BrowserPageLike
    (event: 'console', listener: (message: BrowserConsoleMessageLike) => void): BrowserPageLike
    (event: 'pageerror', listener: (error: Error) => void): BrowserPageLike
    (event: 'close', listener: () => void): BrowserPageLike
  }
}

export interface BrowserInstanceLike {
  close: () => Promise<void>
  version: () => string
}

export interface BrowserContextLike {
  addInitScript: (script: { content: string } | { path: string }) => Promise<unknown>
  browser: () => BrowserInstanceLike | null
  close: () => Promise<void>
  newPage: () => Promise<BrowserPageLike>
  pages: () => BrowserPageLike[]
  on: (event: 'page', listener: (page: BrowserPageLike) => void) => BrowserContextLike
  once: (event: 'close', listener: () => void) => BrowserContextLike
}

export interface BrowserLaunchSettings {
  browserName: BrowserName
  channel: string
  headless: boolean
  persistentContext: boolean
  noViewport: boolean
  profilePath: string
  launchOptions: Record<string, unknown>
}

export interface BrowserRuntimeInfo {
  backend: BrowserBackendName
  backendVersion: string
  browserName: BrowserName
  browserVersion: string
  channel: string
  headless: boolean
  persistentContext: boolean
  profilePath: string
  platform?: string
  fallbackReason?: string
}

export interface BrowserBackend {
  readonly name: BrowserBackendName
  start: () => Promise<void>
  newPage: () => Promise<BrowserPageLike>
  getContext: () => Promise<BrowserContextLike>
  getRuntimeInfo: () => BrowserRuntimeInfo
  close: () => Promise<void>
}

export interface BrowserBackendRequest {
  backend?: BrowserBackendName
  platform?: string
  browserName?: BrowserName
  requiredCapabilities?: BrowserCapability[]
}

export class BrowserBackendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserBackendError'
  }
}

export class BrowserBackendCompatibilityError extends BrowserBackendError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserBackendCompatibilityError'
  }
}

export class BrowserBackendUnavailableError extends BrowserBackendCompatibilityError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserBackendUnavailableError'
  }
}

export class BrowserProfileInUseError extends BrowserBackendError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BrowserProfileInUseError'
  }
}
