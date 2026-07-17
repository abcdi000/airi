/**
 * Direct Chrome DevTools Protocol (CDP) bridge for browser DOM access.
 *
 * Connects to Chrome/Chromium via the CDP WebSocket endpoint (e.g.
 * http://localhost:9222) to provide:
 *   - Accessibility tree snapshots (via Accessibility domain)
 *   - DOM queries and manipulation (via Runtime.evaluate)
 *   - Page navigation and observation
 *
 * This complements the extension-based bridge by not requiring a Chrome
 * extension to be installed — only that Chrome is launched with
 * --remote-debugging-port.
 */

import { WebSocket } from 'ws'

export interface CdpBridgeConfig {
  /** CDP endpoint URL, e.g. http://localhost:9222 */
  cdpUrl: string
  /** Request timeout in milliseconds */
  requestTimeoutMs: number
  /**
   * WebSocket heartbeat interval in milliseconds.
   *
   * @default 5000
   */
  heartbeatIntervalMs?: number
  /**
   * Consecutive missed heartbeat pongs before tearing down the bridge.
   *
   * @default 3
   */
  heartbeatFailureLimit?: number
}

export interface CdpBridgeStatus {
  cdpUrl: string
  connected: boolean
  pageTitle?: string
  pageUrl?: string
  lastError?: string
}

export interface CdpAXNode {
  nodeId: string
  role: string
  name?: string
  value?: string
  description?: string
  bounds?: { x: number, y: number, width: number, height: number }
  focused?: boolean
  children: CdpAXNode[]
}

export interface CdpAXSnapshot {
  nodes: CdpAXNode[]
  pageUrl: string
  pageTitle: string
  capturedAt: string
}

interface CdpMessage {
  id: number
  method: string
  params?: Record<string, unknown>
}

interface CdpResponse {
  id: number
  result?: any
  error?: { code: number, message: string }
}

interface CdpEvent {
  method: string
  params?: Record<string, unknown>
}

interface PendingCdpRequest {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeoutId: NodeJS.Timeout
}

interface PendingCdpEvent {
  resolve: (value: CdpEvent) => void
  reject: (error: Error) => void
  timeoutId: NodeJS.Timeout
}

interface CdpTargetInfo {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

const NAVIGATION_ABORTED_RE = /ERR_ABORTED/i
const ABORTED_NAVIGATION_SETTLE_MS = 500

function delay(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

export class CdpBridge {
  private socket?: WebSocket
  private heartbeatTimer?: NodeJS.Timeout
  private awaitingHeartbeatPong = false
  private consecutiveHeartbeatFailures = 0
  private nextId = 1
  private pending = new Map<number, PendingCdpRequest>()
  private eventWaiters = new Map<string, Set<PendingCdpEvent>>()
  private status: CdpBridgeStatus

  constructor(private readonly config: CdpBridgeConfig) {
    this.status = {
      cdpUrl: config.cdpUrl,
      connected: false,
    }
  }

  getStatus(): CdpBridgeStatus {
    return { ...this.status }
  }

  /**
   * Connect to the first available page target via CDP.
   */
  async connect(): Promise<void> {
    // Fetch available targets from the CDP HTTP endpoint
    const listUrl = `${this.config.cdpUrl}/json/list`
    const response = await fetch(listUrl)

    if (!response.ok) {
      throw new Error(`CDP target list failed: ${response.status} ${response.statusText}`)
    }

    const targets = await response.json() as CdpTargetInfo[]
    const pageTarget = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)

    if (!pageTarget?.webSocketDebuggerUrl) {
      throw new Error('no page target with WebSocket debugger URL found')
    }

    await this.connectToTarget(pageTarget)
  }

  /**
   * Connect to a specific CDP target.
   */
  async connectToTarget(target: CdpTargetInfo): Promise<void> {
    if (this.socket) {
      await this.close()
    }

    const wsUrl = target.webSocketDebuggerUrl!

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(wsUrl)
      let connectionSettled = false

      socket.on('open', () => {
        if (connectionSettled)
          return
        connectionSettled = true
        this.socket = socket
        this.status.connected = true
        this.status.pageTitle = target.title
        this.status.pageUrl = target.url
        this.status.lastError = undefined
        resolve()
      })

      socket.on('message', (data) => {
        if (this.socket !== socket)
          return
        this.handleMessage(data)
      })

      socket.on('pong', () => {
        if (this.socket !== socket)
          return
        this.consecutiveHeartbeatFailures = 0
        this.awaitingHeartbeatPong = false
      })

      socket.on('close', () => {
        if (this.socket !== socket)
          return
        this.handleSocketClosed('CDP WebSocket closed')
      })

      socket.on('error', (error) => {
        if (this.socket && this.socket !== socket)
          return

        const message = error instanceof Error ? error.message : String(error)
        if (!this.socket && connectionSettled)
          return

        this.status.lastError = message
        if (!this.socket) {
          connectionSettled = true
          reject(new Error(`CDP WebSocket connection failed: ${message}`))
        }
      })
    })

    // Enable required CDP domains
    await this.send('Page.enable', {})
    await this.send('Accessibility.enable', {})
    await this.send('DOM.enable', {})
    await this.send('Runtime.enable', {})
    this.startHeartbeat()
  }

  /**
   * Close the CDP connection.
   */
  async close(): Promise<void> {
    this.clearHeartbeat()
    this.rejectPendingRequests('CDP bridge closed')
    this.rejectPendingEvents('CDP bridge closed')
    this.awaitingHeartbeatPong = false
    this.consecutiveHeartbeatFailures = 0

    if (this.socket) {
      this.socket.close()
      this.socket = undefined
    }
    this.status.connected = false
  }

  /**
   * Send a CDP command and wait for the response.
   */
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`CDP bridge is not connected (status: ${this.status.lastError || 'disconnected'})`)
    }

    const id = this.nextId++
    const message: CdpMessage = { id, method, params }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command ${method} timed out after ${this.config.requestTimeoutMs}ms`))
      }, this.config.requestTimeoutMs)

      this.pending.set(id, { resolve, reject, timeoutId })
      this.socket!.send(JSON.stringify(message))
    })
  }

  /**
   * Get the full accessibility tree of the current page.
   */
  async getAccessibilityTree(): Promise<CdpAXSnapshot> {
    const result = await this.send('Accessibility.getFullAXTree', {})
    const nodes = (result.nodes ?? []) as any[]

    // Build a tree from the flat CDP AX node list
    const nodeMap = new Map<string, CdpAXNode>()
    const rootNodes: CdpAXNode[] = []

    for (const raw of nodes) {
      const node: CdpAXNode = {
        nodeId: raw.nodeId ?? '',
        role: raw.role?.value ?? '',
        name: raw.name?.value,
        value: raw.value?.value,
        description: raw.description?.value,
        focused: raw.properties?.some((p: any) => p.name === 'focused' && p.value?.value === true),
        children: [],
      }
      nodeMap.set(node.nodeId, node)
    }

    // Wire parent-child relationships
    for (const raw of nodes) {
      const parentNode = nodeMap.get(raw.nodeId ?? '')
      if (!parentNode)
        continue

      const childIds = raw.childIds ?? []
      for (const childId of childIds) {
        const child = nodeMap.get(childId)
        if (child) {
          parentNode.children.push(child)
        }
      }

      if (!raw.parentId && parentNode) {
        rootNodes.push(parentNode)
      }
    }

    return {
      nodes: rootNodes,
      pageUrl: this.status.pageUrl ?? '',
      pageTitle: this.status.pageTitle ?? '',
      capturedAt: new Date().toISOString(),
    }
  }

  /**
   * Evaluate a JavaScript expression in the page context.
   */
  async evaluate(expression: string): Promise<any> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })

    if (result.exceptionDetails) {
      const text = result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? 'evaluation failed'
      throw new Error(`CDP evaluate error: ${text}`)
    }

    return result.result?.value
  }

  /**
   * Navigate the current page to a URL.
   */
  async navigate(url: string): Promise<void> {
    const loadWaiter = this.waitForEvent('Page.loadEventFired')
    let loadError: unknown
    const loadPromise = loadWaiter.promise.catch((error) => {
      loadError = error
    })
    try {
      const result = await this.send('Page.navigate', { url })
      if (result.errorText) {
        loadWaiter.cancel()
        if (NAVIGATION_ABORTED_RE.test(String(result.errorText))) {
          await delay(ABORTED_NAVIGATION_SETTLE_MS)
          await this.refreshPageStatus()
          return
        }
        throw new Error(`CDP navigation failed: ${result.errorText}`)
      }

      if (result.loaderId) {
        await loadPromise
        if (loadError)
          throw loadError
      }
      else {
        loadWaiter.cancel()
      }

      await this.refreshPageStatus()
    }
    catch (error) {
      loadWaiter.cancel()
      throw error
    }
  }

  /**
   * Take a screenshot of the current page.
   * Returns base64-encoded PNG data.
   */
  async screenshot(options?: { format?: 'png' | 'jpeg', quality?: number }): Promise<string> {
    const result = await this.send('Page.captureScreenshot', {
      format: options?.format ?? 'png',
      quality: options?.quality,
    })
    return result.data
  }

  /**
   * Get interactive DOM elements via Runtime.evaluate, similar to
   * the extension's collectFrameDOM. Injects a small script that
   * collects visible interactive elements.
   */
  async collectInteractiveElements(maxElements = 200): Promise<any[]> {
    const expression = `
      (() => {
        const selectors = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"]';
        const elements = [...document.querySelectorAll(selectors)];
        const results = [];
        for (const el of elements) {
          if (results.length >= ${maxElements}) break;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          const visible = rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
          if (!visible) continue;
          results.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            name: el.getAttribute('name') || undefined,
            type: el.getAttribute('type') || undefined,
            text: (el.innerText || '').slice(0, 120) || undefined,
            value: el.value !== undefined ? String(el.value).slice(0, 120) : undefined,
            href: el.href || undefined,
            placeholder: el.placeholder || undefined,
            disabled: el.disabled || undefined,
            checked: el.checked || undefined,
            role: el.getAttribute('role') || undefined,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
          });
        }
        return results;
      })()
    `

    return await this.evaluate(expression)
  }

  /**
   * Format the CDP accessibility tree as text for LLM context.
   */
  formatAXTreeAsText(snapshot: CdpAXSnapshot): string {
    const lines: string[] = []
    lines.push(`[Browser AXTree] ${snapshot.pageTitle} (${snapshot.pageUrl})`)

    function walk(node: CdpAXNode, depth: number) {
      const prefix = '  '.repeat(depth)
      const parts: string[] = [node.role || '(no role)']

      if (node.name) {
        parts.push(`"${node.name}"`)
      }
      if (node.value) {
        const truncated = node.value.length > 80 ? `${node.value.slice(0, 77)}...` : node.value
        parts.push(`val="${truncated}"`)
      }
      if (node.focused) {
        parts.push('[focused]')
      }

      lines.push(`${prefix}${parts.join(' ')}`)

      for (const child of node.children) {
        walk(child, depth + 1)
      }
    }

    for (const root of snapshot.nodes) {
      walk(root, 0)
    }

    return lines.join('\n')
  }

  private async refreshPageStatus() {
    const pageInfo = await this.evaluate(`({ url: window.location.href, title: document.title })`)
    if (pageInfo && typeof pageInfo === 'object') {
      const record = pageInfo as { url?: unknown, title?: unknown }
      this.status.pageUrl = typeof record.url === 'string' ? record.url : this.status.pageUrl
      this.status.pageTitle = typeof record.title === 'string' ? record.title : this.status.pageTitle
    }
  }

  private waitForEvent(method: string) {
    const timeoutMs = this.config.requestTimeoutMs
    let waiter: PendingCdpEvent | undefined
    const promise = new Promise<CdpEvent>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (waiter)
          this.removeEventWaiter(method, waiter)
        reject(new Error(`CDP event ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      waiter = { resolve, reject, timeoutId }
      const waiters = this.eventWaiters.get(method) ?? new Set<PendingCdpEvent>()
      waiters.add(waiter)
      this.eventWaiters.set(method, waiters)
    })

    return {
      promise,
      cancel: () => {
        if (!waiter)
          return
        clearTimeout(waiter.timeoutId)
        this.removeEventWaiter(method, waiter)
        waiter = undefined
      },
    }
  }

  private removeEventWaiter(method: string, waiter: PendingCdpEvent) {
    const waiters = this.eventWaiters.get(method)
    if (!waiters)
      return

    waiters.delete(waiter)
    if (waiters.size === 0)
      this.eventWaiters.delete(method)
  }

  private resolveEventWaiters(event: CdpEvent) {
    const waiters = this.eventWaiters.get(event.method)
    if (!waiters)
      return

    this.eventWaiters.delete(event.method)
    for (const waiter of waiters) {
      clearTimeout(waiter.timeoutId)
      waiter.resolve(event)
    }
  }

  private handleMessage(raw: any) {
    let data: (CdpResponse & Partial<CdpEvent>) | undefined
    try {
      data = JSON.parse(String(raw)) as CdpResponse & Partial<CdpEvent>
    }
    catch {
      return
    }

    if (data && typeof data.method === 'string') {
      this.resolveEventWaiters({
        method: data.method,
        params: data.params,
      })
    }

    if (!data || typeof data.id !== 'number')
      return

    const pending = this.pending.get(data.id)
    if (!pending)
      return

    clearTimeout(pending.timeoutId)
    this.pending.delete(data.id)

    if (data.error) {
      pending.reject(new Error(`CDP error: ${data.error.message} (${data.error.code})`))
    }
    else {
      pending.resolve(data.result)
    }
  }

  private startHeartbeat() {
    this.clearHeartbeat()
    this.awaitingHeartbeatPong = false
    this.consecutiveHeartbeatFailures = 0

    const intervalMs = this.config.heartbeatIntervalMs ?? 5_000
    const failureLimit = this.config.heartbeatFailureLimit ?? 3

    if (intervalMs <= 0 || failureLimit <= 0) {
      return
    }

    this.heartbeatTimer = setInterval(() => {
      const socket = this.socket
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        this.handleSocketClosed('CDP heartbeat found closed WebSocket')
        return
      }

      if (this.awaitingHeartbeatPong) {
        this.consecutiveHeartbeatFailures += 1
        if (this.consecutiveHeartbeatFailures >= failureLimit) {
          this.teardownAfterHeartbeatFailure()
          return
        }
      }

      try {
        socket.ping()
        this.awaitingHeartbeatPong = true
      }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.teardownAfterHeartbeatFailure(message)
      }
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  private clearHeartbeat() {
    if (!this.heartbeatTimer) {
      return
    }

    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  private teardownAfterHeartbeatFailure(reason?: string) {
    const failureLimit = this.config.heartbeatFailureLimit ?? 3
    this.status.lastError = reason ?? `CDP heartbeat failed after ${failureLimit} consecutive missed pongs`
    this.clearHeartbeat()
    this.rejectPendingRequests(this.status.lastError)
    this.rejectPendingEvents(this.status.lastError)

    const socket = this.socket
    this.socket = undefined
    this.status.connected = false
    this.awaitingHeartbeatPong = false
    this.consecutiveHeartbeatFailures = 0
    socket?.terminate()
  }

  private handleSocketClosed(reason: string) {
    this.status.lastError = reason
    this.clearHeartbeat()
    this.rejectPendingRequests(reason)
    this.rejectPendingEvents(reason)
    this.socket = undefined
    this.status.connected = false
    this.awaitingHeartbeatPong = false
    this.consecutiveHeartbeatFailures = 0
  }

  private rejectPendingRequests(reason: string) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeoutId)
      pending.reject(new Error(`${reason} before completing request ${id}`))
    }
    this.pending.clear()
  }

  private rejectPendingEvents(reason: string) {
    for (const waiters of this.eventWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeoutId)
        waiter.reject(new Error(`${reason} before receiving CDP event`))
      }
    }
    this.eventWaiters.clear()
  }
}
