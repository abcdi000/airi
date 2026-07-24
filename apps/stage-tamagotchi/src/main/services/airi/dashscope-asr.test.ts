import { createContext, defineInvoke } from '@moeru/eventa'
import {
  electronDashScopeAsrClientEvent,
  electronDashScopeAsrStart,
} from '@proj-airi/stage-shared'
import { describe, expect, it } from 'vitest'

import { createDashScopeAsrService } from './dashscope-asr'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1

  readonly sent: Array<string | Buffer> = []
  readyState = FakeWebSocket.CONNECTING
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()

  constructor(_url: string, _options?: { headers?: Record<string, string> }) {}

  on(event: string, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  send(data: string | Buffer) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.emit('open')
  }

  receive(payload: object) {
    this.emit('message', Buffer.from(JSON.stringify(payload)))
  }

  private emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? [])
      listener(...args)
  }
}

describe('createDashScopeAsrService', () => {
  it('sends an early file-finish request after task-started', async () => {
    // ROOT CAUSE:
    //
    // A short recording is read before DashScope acknowledges run-task. The old
    // service discarded finish-task while the socket was still starting, so
    // DashScope waited for more audio and failed after its fixed 23-second idle
    // timeout. The service now remembers the finish request and sends it after
    // pending audio once task-started arrives.
    const context = createContext()
    let socket: FakeWebSocket | undefined
    class CapturedWebSocket extends FakeWebSocket {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        super(url, options)
        socket = this
      }
    }

    createDashScopeAsrService({
      context: context as never,
      webSocketImpl: CapturedWebSocket as never,
    })
    const start = defineInvoke(context, electronDashScopeAsrStart)

    await start({
      sessionId: 'short-recording',
      apiKey: 'test-key',
      baseUrl: 'wss://example.invalid/asr',
      model: 'paraformer-realtime-v2',
      sampleRate: 16000,
    })
    context.emit(electronDashScopeAsrClientEvent, {
      sessionId: 'short-recording',
      type: 'audio',
      chunk: new Uint8Array([1, 2, 3]),
    })
    context.emit(electronDashScopeAsrClientEvent, {
      sessionId: 'short-recording',
      type: 'finish',
    })

    expect(socket).toBeDefined()
    socket!.open()
    socket!.receive({
      header: {
        event: 'task-started',
      },
    })

    expect(socket!.sent).toHaveLength(3)
    expect(JSON.parse(String(socket!.sent[0])).header.action).toBe('run-task')
    expect(Buffer.isBuffer(socket!.sent[1])).toBe(true)
    expect(JSON.parse(String(socket!.sent[2])).header.action).toBe('finish-task')
  })
})
