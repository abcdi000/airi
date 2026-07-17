import type { AddressInfo } from 'node:net'

import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

import { createStreamingTtsPipeline } from './streaming-pipeline'

vi.mock('../auth', () => ({
  getAuthToken: () => 'test-jwt',
}))
vi.mock('../server', () => ({
  SERVER_URL: 'http://placeholder',
}))

interface MockServer {
  url: string
  receivedFrames: Array<{ kind: 'text' | 'binary', data: string | Buffer }>
  connectionUrls: string[]
  /** Resolves when the server has observed a `start` frame from the client. */
  startObserved: Promise<void>
  stop: () => Promise<void>
}

async function startMockServer(handler: (ws: import('ws').WebSocket) => void): Promise<MockServer> {
  const receivedFrames: MockServer['receivedFrames'] = []
  const connectionUrls: string[] = []
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })

  let resolveStartObserved!: () => void
  const startObserved = new Promise<void>((res) => {
    resolveStartObserved = res
  })

  wss.on('connection', (ws, req) => {
    connectionUrls.push(req.url || '')
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      const decoded = isBinary ? buf : buf.toString('utf8')
      receivedFrames.push({ kind: isBinary ? 'binary' : 'text', data: isBinary ? buf : (decoded as string) })
      if (!isBinary) {
        try {
          const ev = JSON.parse(decoded as string) as { event?: string }
          if (ev.event === 'start')
            resolveStartObserved()
        }
        catch {}
      }
    })
    handler(ws)
  })

  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    receivedFrames,
    connectionUrls,
    startObserved,
    async stop() {
      wss.close()
      await new Promise<void>(r => httpServer.close(() => r()))
    },
  }
}

// jsdom-friendly stub AudioContext for `decodeAudioData`. The pipeline does
// not introspect the AudioBuffer beyond passing it to consumers, so any
// shape with the expected fields is fine.
function makeStubAudioContext(): BaseAudioContext {
  let counter = 0
  const ctx = {
    sampleRate: 24000,
    decodeAudioData: vi.fn(async (buf: ArrayBuffer) => {
      // Return a fake AudioBuffer-like object identifiable by index/byteLength.
      counter += 1
      return {
        duration: buf.byteLength / 24000,
        length: buf.byteLength,
        numberOfChannels: 1,
        sampleRate: 24000,
        __index: counter,
        __byteLength: buf.byteLength,
      } as unknown as AudioBuffer
    }),
  }
  return ctx as unknown as BaseAudioContext
}

async function startHybridServer(options: { mimoDelayMs?: number } = {}) {
  const requests: Array<{ path: string, body: any }> = []
  const httpServer = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const body = bodyText ? JSON.parse(bodyText) : {}
      requests.push({ path: req.url || '', body })

      if (req.url === '/v1/audio/speech') {
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'audio/wav' })
          res.end(Buffer.from([1, 2, 3, 4]))
        }, 50)
        return
      }

      if (req.url === '/mimo/chat/completions') {
        setTimeout(() => {
          if (res.destroyed)
            return
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            choices: [
              {
                message: {
                  audio: {
                    data: Buffer.from([5, 6]).toString('base64'),
                  },
                },
              },
            ],
          }))
        }, options.mimoDelayMs ?? 0)
        return
      }

      if (req.url === '/dashscope/tts') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          output: {
            audio: {
              data: Buffer.from([7, 8, 9]).toString('base64'),
            },
          },
        }))
        return
      }

      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise<void>(resolve => httpServer.close(() => resolve())),
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1500) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs)
      throw new Error('waitUntil timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('createStreamingTtsPipeline', () => {
  let server: MockServer | undefined

  beforeEach(() => {
    server = undefined
  })
  afterEach(async () => {
    await server?.stop()
  })

  it('forwards appendText / finish frames and chunks audio per sentence.end', async () => {
    const chunks = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8]), Buffer.from([9, 10, 11, 12])]
    server = await startMockServer((ws) => {
      ws.on('message', async (data, isBinary) => {
        if (isBinary)
          return
        const ev = JSON.parse(data.toString()) as { event?: string }
        if (ev.event === 'finish') {
          // First sentence: chunk1 + chunk2 鈫?sentence.end
          ws.send(JSON.stringify({ event: 'sentence.start', payload: { text: 'first one.' } }))
          ws.send(chunks[0], { binary: true })
          ws.send(chunks[1], { binary: true })
          ws.send(JSON.stringify({ event: 'sentence.end', payload: { text: 'first one.' } }))
          // Second sentence: chunk3 鈫?sentence.end
          ws.send(JSON.stringify({ event: 'sentence.start', payload: { text: 'second sentence.' } }))
          ws.send(chunks[2], { binary: true })
          ws.send(JSON.stringify({ event: 'sentence.end', payload: { text: 'second sentence.' } }))
          ws.send(JSON.stringify({ event: 'session.finished', payload: { usage: { text_words: 4 } } }))
        }
      })
    })

    const onSentence = vi.fn()
    const onError = vi.fn()
    const onDone = vi.fn()

    const handle = createStreamingTtsPipeline({
      serverUrl: server.url,
      model: 'volcengine/seed-tts-1.0',
      voice: 'mock',
      audioContext: makeStubAudioContext(),
      onSentence,
      onError,
      onDone,
    })

    handle.appendText('hi ')
    handle.appendText('there')
    handle.finish()

    await waitUntil(() => onSentence.mock.calls.length === 2)

    await server.startObserved
    const textFrames = server.receivedFrames.filter(f => f.kind === 'text').map(f => JSON.parse(f.data as string))
    expect(textFrames.map(f => f.event)).toEqual(['start', 'text', 'text', 'finish'])
    expect(textFrames[1]).toMatchObject({ event: 'text', text: 'hi ' })
    expect(textFrames[2]).toMatchObject({ event: 'text', text: 'there' })

    expect(onError).not.toHaveBeenCalled()
    // Two `sentence.end` events 鈫?two AudioBuffers.
    expect(onSentence).toHaveBeenCalledTimes(2)
    const calls = onSentence.mock.calls.map(([s]) => s as { index: number, text: string, audio: { __byteLength: number } })
    expect(calls[0]).toMatchObject({ index: 0, text: 'first one.' })
    expect(calls[0].audio.__byteLength).toBe(chunks[0].length + chunks[1].length)
    expect(calls[1]).toMatchObject({ index: 1, text: 'second sentence.' })
    expect(calls[1].audio.__byteLength).toBe(chunks[2].length)
  })

  it('buffers entire session when bufferEntireSession is true', async () => {
    const chunks = [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])]
    server = await startMockServer((ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary)
          return
        const ev = JSON.parse(data.toString()) as { event?: string }
        if (ev.event === 'finish') {
          // Two sentences with sentence.end events 鈥?but the pipeline should
          // IGNORE them in buffered mode (TTS 2.0 ships subtitles async).
          ws.send(chunks[0], { binary: true })
          ws.send(JSON.stringify({ event: 'sentence.end', payload: { text: 'sentence 1' } }))
          ws.send(chunks[1], { binary: true })
          ws.send(JSON.stringify({ event: 'sentence.end', payload: { text: 'sentence 2' } }))
          ws.send(JSON.stringify({ event: 'session.finished', payload: {} }))
        }
      })
    })

    const onSentence = vi.fn()
    const handle = createStreamingTtsPipeline({
      serverUrl: server.url,
      model: 'volcengine/seed-tts-2.0',
      voice: 'mock',
      audioContext: makeStubAudioContext(),
      bufferEntireSession: true,
      onSentence,
    })

    handle.finish()

    await new Promise<void>(resolve => setTimeout(resolve, 800))

    expect(onSentence).toHaveBeenCalledTimes(1)
    const [sentence] = onSentence.mock.calls[0] as [{ index: number, audio: { __byteLength: number } }]
    expect(sentence.index).toBe(0)
    expect(sentence.audio.__byteLength).toBe(chunks[0].length + chunks[1].length)
  })

  it('surfaces upstream error event then closes', async () => {
    server = await startMockServer((ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary)
          return
        const ev = JSON.parse(data.toString()) as { event?: string }
        if (ev.event === 'start') {
          ws.send(JSON.stringify({ event: 'error', code: 'insufficient_flux', message: 'top up' }))
        }
      })
    })

    const onError = vi.fn()
    const onDone = vi.fn()
    createStreamingTtsPipeline({
      serverUrl: server.url,
      model: 'volcengine/seed-tts-1.0',
      voice: 'mock',
      audioContext: makeStubAudioContext(),
      onError,
      onDone,
    })

    await new Promise<void>((resolve) => {
      onDone.mockImplementation(() => resolve())
      setTimeout(resolve, 1500)
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/insufficient_flux.*top up/)
  })

  it('surfaces close-before-finished as error', async () => {
    server = await startMockServer((ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary)
          return
        const ev = JSON.parse(data.toString()) as { event?: string }
        if (ev.event === 'start') {
          // Drop ws without sending session.finished.
          setTimeout(() => ws.close(1011, 'simulated_truncation'), 10)
        }
      })
    })

    const onError = vi.fn()
    const onDone = vi.fn()
    createStreamingTtsPipeline({
      serverUrl: server.url,
      model: 'volcengine/seed-tts-1.0',
      voice: 'mock',
      audioContext: makeStubAudioContext(),
      onError,
      onDone,
    })

    await new Promise<void>((resolve) => {
      onDone.mockImplementation(() => resolve())
      setTimeout(resolve, 1500)
    })

    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0][0] as Error).message).toMatch(/streaming_tts_closed/)
  })

  it('cancel() sends cancel frame and terminates', async () => {
    let cancelObserved = false
    server = await startMockServer((ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary)
          return
        const ev = JSON.parse(data.toString()) as { event?: string }
        if (ev.event === 'cancel')
          cancelObserved = true
      })
    })

    const onDone = vi.fn()
    const handle = createStreamingTtsPipeline({
      serverUrl: server.url,
      model: 'volcengine/seed-tts-1.0',
      voice: 'mock',
      audioContext: makeStubAudioContext(),
      onDone,
    })

    await server.startObserved
    handle.cancel()

    await waitUntil(() => cancelObserved)

    expect(cancelObserved).toBe(true)
  })

  it('can connect to a local unauthenticated websocket path', async () => {
    server = await startMockServer((ws) => {
      ws.on('message', (data, isBinary) => {
        if (isBinary)
          return
        const ev = JSON.parse(data.toString()) as { event?: string }
        if (ev.event === 'finish') {
          ws.send(JSON.stringify({ event: 'session.finished', payload: {} }))
        }
      })
    })

    const onDone = vi.fn()
    const handle = createStreamingTtsPipeline({
      serverUrl: `${server.url}/v1/`,
      wsPath: 'audio/speech/ws',
      requiresAuth: false,
      model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
      voice: 'lumi_clone',
      audioContext: makeStubAudioContext(),
      onDone,
    })

    handle.appendText('local qwen')
    handle.finish()

    await new Promise<void>((resolve) => {
      onDone.mockImplementation(() => resolve())
      setTimeout(resolve, 1500)
    })
    await server.startObserved

    expect(server.connectionUrls[0]).toBe('/v1/audio/speech/ws')
    const textFrames = server.receivedFrames.filter(f => f.kind === 'text').map(f => JSON.parse(f.data as string))
    expect(textFrames.map(f => f.event)).toEqual(['start', 'text', 'finish'])
  })

  it('hybrid mode synthesizes local and MiMo lanes in parallel but emits audio in text order', async () => {
    const hybridServer = await startHybridServer()
    const onSentence = vi.fn()
    const onDone = vi.fn()
    const onDebug = vi.fn()
    try {
      const handle = createStreamingTtsPipeline({
        debugSessionId: 'debug-session',
        serverUrl: `${hybridServer.url}/v1/`,
        requiresAuth: false,
        model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        voice: 'lumi_clone',
        responseFormat: 'wav',
        audioContext: makeStubAudioContext(),
        onSentence,
        onDone,
        onDebug,
        hybrid: {
          enabled: true,
          cloudProviderId: 'mimo-audio-speech',
          cloudConfig: {
            apiKey: 'test-key',
            baseUrl: `${hybridServer.url}/mimo`,
            model: 'mimo-v2.5-tts',
            voice: '鍐扮硸',
            format: 'wav',
          },
          firstSegmentMinChars: 12,
          segmentMinChars: 12,
          localMaxChars: 40,
          cloudMaxChars: 40,
          cloudMinChars: 12,
          cloudMinIntervalMs: 1,
          cloudSoftRpm: 100,
        },
      })

      handle.appendText('a'.repeat(40) + 'b'.repeat(40) + 'c'.repeat(40) + 'd'.repeat(40))
      handle.finish()

      await waitUntil(() => onSentence.mock.calls.length === 4)

      const calls = onSentence.mock.calls.map(([s]) => s as { index: number, text: string, audio: { __byteLength: number } })
      expect(calls.map(call => call.index)).toEqual([0, 1, 2, 3])
      expect(calls[0].audio.__byteLength).toBe(4)
      expect(calls[1].audio.__byteLength).toBe(2)
      expect(calls[2].audio.__byteLength).toBe(4)
      expect(calls[3].audio.__byteLength).toBe(2)
      expect(hybridServer.requests.map(req => req.path)).toEqual([
        '/v1/audio/speech',
        '/mimo/chat/completions',
        '/v1/audio/speech',
        '/mimo/chat/completions',
      ])
      expect(hybridServer.requests.filter(req => req.path === '/v1/audio/speech')).toHaveLength(2)
      expect(hybridServer.requests.filter(req => req.path === '/mimo/chat/completions')).toHaveLength(2)
      expect(hybridServer.requests.find(req => req.path === '/mimo/chat/completions')?.body).toMatchObject({
        model: 'mimo-v2.5-tts',
        audio: { voice: '鍐扮硸', format: 'wav' },
      })
      const debugEvents = onDebug.mock.calls.map(([event]) => event as { sessionId: string, phase: string, lane?: string, segmentIndex?: number })
      expect(debugEvents[0]).toMatchObject({ sessionId: 'debug-session', phase: 'session_started' })
      expect(debugEvents.filter(event => event.phase === 'segment_queued').map(event => [event.segmentIndex, event.lane])).toEqual([
        [0, 'local'],
        [1, 'cloud'],
        [2, 'local'],
        [3, 'cloud'],
      ])
      expect(debugEvents.filter(event => event.phase === 'segment_emitted').map(event => event.segmentIndex)).toEqual([0, 1, 2, 3])
    }
    finally {
      await hybridServer.stop()
    }
  })

  it('falls back to local when a MiMo hybrid request times out', async () => {
    const hybridServer = await startHybridServer({ mimoDelayMs: 300 })
    const onSentence = vi.fn()
    const onDebug = vi.fn()
    try {
      const handle = createStreamingTtsPipeline({
        debugSessionId: 'timeout-session',
        serverUrl: `${hybridServer.url}/v1/`,
        requiresAuth: false,
        model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        voice: 'lumi_clone',
        responseFormat: 'wav',
        audioContext: makeStubAudioContext(),
        onSentence,
        onDebug,
        hybrid: {
          enabled: true,
          cloudProviderId: 'mimo-audio-speech',
          cloudConfig: {
            apiKey: 'test-key',
            baseUrl: `${hybridServer.url}/mimo`,
            model: 'mimo-v2.5-tts',
            voice: '鍐扮硸',
            format: 'wav',
          },
          firstSegmentMinChars: 12,
          segmentMinChars: 12,
          localMaxChars: 40,
          cloudMaxChars: 40,
          cloudMinChars: 12,
          cloudMinIntervalMs: 1,
          cloudSoftRpm: 100,
          cloudRequestTimeoutMs: 100,
        },
      })

      handle.appendText('a'.repeat(40) + 'b'.repeat(40))
      handle.finish()

      await waitUntil(() => onSentence.mock.calls.length === 2, 2000)

      const calls = onSentence.mock.calls.map(([s]) => s as { index: number, audio: { __byteLength: number } })
      expect(calls.map(call => call.index)).toEqual([0, 1])
      expect(calls.map(call => call.audio.__byteLength)).toEqual([4, 4])
      const debugEvents = onDebug.mock.calls.map(([event]) => event as { phase: string, lane?: string, segmentIndex?: number, error?: string })
      expect(debugEvents).toContainEqual(expect.objectContaining({
        phase: 'segment_fallback',
        lane: 'local',
        segmentIndex: 1,
      }))
      expect(debugEvents.find(event => event.phase === 'segment_fallback' && event.segmentIndex === 1)?.error).toContain('timed out')
    }
    finally {
      await hybridServer.stop()
    }
  })

  it('hybrid mode can use DashScope CosyVoice as the cloud lane', async () => {
    const hybridServer = await startHybridServer()
    const onSentence = vi.fn()
    try {
      const handle = createStreamingTtsPipeline({
        debugSessionId: 'dashscope-session',
        serverUrl: `${hybridServer.url}/v1/`,
        requiresAuth: false,
        model: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
        voice: 'lumi_clone',
        responseFormat: 'wav',
        audioContext: makeStubAudioContext(),
        onSentence,
        hybrid: {
          enabled: true,
          cloudProviderId: 'alibaba-cloud-model-studio',
          cloudConfig: {
            apiKey: 'test-key',
            baseUrl: `${hybridServer.url}/dashscope/tts`,
            model: 'cosyvoice-v3.5-flash',
            customVoiceId: 'cosyvoice-v3.5-flash-lumi-test',
            format: 'wav',
            sampleRate: 24000,
            languageHint: 'zh',
          },
          firstSegmentMinChars: 12,
          segmentMinChars: 12,
          localMaxChars: 40,
          cloudMaxChars: 40,
          cloudMinChars: 12,
          cloudMinIntervalMs: 1,
          cloudSoftRpm: 100,
        },
      })

      handle.appendText('local lane has enough words to split cleanly cloud lane has enough words to split cleanly')
      handle.finish()

      await waitUntil(() => onSentence.mock.calls.length === 2)

      const calls = onSentence.mock.calls.map(([s]) => s as { index: number, audio: { __byteLength: number } })
      expect(calls.map(call => call.index)).toEqual([0, 1])
      expect(calls.map(call => call.audio.__byteLength)).toEqual([4, 3])

      const dashscopeRequest = hybridServer.requests.find(req => req.path === '/dashscope/tts')
      expect(dashscopeRequest?.body).toMatchObject({
        model: 'cosyvoice-v3.5-flash',
        input: {
          voice: 'cosyvoice-v3.5-flash-lumi-test',
          format: 'wav',
          sample_rate: 24000,
          language_hints: ['zh'],
        },
      })
    }
    finally {
      await hybridServer.stop()
    }
  })
})
