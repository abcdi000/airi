import type { DashScopeAsrServerEvent } from '@proj-airi/stage-shared'
import type { CommonRequestOptions } from '@xsai/shared'
import type { StreamTranscriptionDelta, StreamTranscriptionResult } from '@xsai/stream-transcription'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/renderer'
import { electronDashScopeAsrClientEvent, electronDashScopeAsrServerEvent, electronDashScopeAsrStart } from '@proj-airi/stage-shared'

type AudioChunk = ArrayBuffer | ArrayBufferView

export interface DashScopeRealtimeAsrExtraOptions {
  abortSignal?: AbortSignal
  inputAudioStream?: ReadableStream<AudioChunk>
  sampleRate?: number
  languageHints?: string[]
  workspaceId?: string
  vocabularyId?: string
  maxSentenceSilence?: number
  semanticPunctuationEnabled?: boolean
  punctuationPredictionEnabled?: boolean
  inverseTextNormalizationEnabled?: boolean
  disfluencyRemovalEnabled?: boolean
  multiThresholdModeEnabled?: boolean
  heartbeat?: boolean
}

interface DashScopeStreamTranscriptionOptions extends DashScopeRealtimeAsrExtraOptions {
  baseURL?: CommonRequestOptions['baseURL']
  model: string
  headers?: HeadersInit
  file?: Blob
  inputStream?: ReadableStream<AudioChunk>
  apiKey?: string
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

function resolveAudioStream(options: DashScopeStreamTranscriptionOptions): ReadableStream<AudioChunk> {
  const stream = options.inputAudioStream ?? options.inputStream ?? options.file?.stream()
  if (!stream)
    throw new TypeError('Audio stream or file is required for DashScope realtime transcription.')

  return stream as ReadableStream<AudioChunk>
}

function toUint8Array(chunk: AudioChunk): Uint8Array {
  if (chunk instanceof ArrayBuffer)
    return new Uint8Array(chunk)

  if (ArrayBuffer.isView(chunk))
    return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength))

  throw new TypeError('Unsupported audio chunk type for DashScope realtime transcription.')
}

function resolveApiKey(options: DashScopeStreamTranscriptionOptions): string {
  if (options.apiKey)
    return options.apiKey

  const headers = new Headers(options.headers)
  const auth = headers.get('authorization') || headers.get('Authorization') || ''
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function resolveBaseUrl(options: DashScopeStreamTranscriptionOptions): string {
  const base = options.baseURL instanceof URL ? options.baseURL.toString() : `${options.baseURL || ''}`
  return base.trim() || 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
}

function getElectronContext() {
  const ipcRenderer = (globalThis as { window?: { electron?: { ipcRenderer?: Parameters<typeof createContext>[0] } } }).window?.electron?.ipcRenderer
  if (!ipcRenderer)
    throw new Error('DashScope realtime ASR requires the AIRI desktop runtime. Browser WebSocket cannot send the required Authorization header.')

  return createContext(ipcRenderer).context
}

function randomSessionId() {
  if (globalThis.crypto?.randomUUID)
    return globalThis.crypto.randomUUID()
  return `dashscope-asr-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function streamDashScopeTranscription(options: DashScopeStreamTranscriptionOptions): StreamTranscriptionResult {
  const audioStream = resolveAudioStream(options)
  const apiKey = resolveApiKey(options)
  if (!apiKey)
    throw new Error('DashScope API key is required for realtime ASR.')

  const context = getElectronContext()
  const start = defineInvoke(context, electronDashScopeAsrStart)
  const sessionId = randomSessionId()
  const deferredText = createDeferred<string>()

  let text = ''
  let textStreamCtrl: ReadableStreamDefaultController<string> | undefined
  let fullStreamCtrl: ReadableStreamDefaultController<StreamTranscriptionDelta> | undefined

  const fullStream = new ReadableStream<StreamTranscriptionDelta>({
    start(controller) {
      fullStreamCtrl = controller
    },
  })

  const textStream = new ReadableStream<string>({
    start(controller) {
      textStreamCtrl = controller
    },
  })

  function cleanup() {
    disposeEvent?.()
    options.abortSignal?.removeEventListener('abort', onAbort)
  }

  function fail(error: unknown) {
    cleanup()
    fullStreamCtrl?.error(error)
    textStreamCtrl?.error(error)
    deferredText.reject(error)
  }

  function finish() {
    cleanup()
    fullStreamCtrl?.close()
    textStreamCtrl?.close()
    deferredText.resolve(text.trim())
  }

  function onAbort() {
    context.emit(electronDashScopeAsrClientEvent, {
      sessionId,
      type: 'abort',
      reason: 'Aborted',
    })
    fail(options.abortSignal?.reason ?? new DOMException('Aborted', 'AbortError'))
  }

  const disposeEvent = context.on(electronDashScopeAsrServerEvent, (event) => {
    const body = event.body as DashScopeAsrServerEvent | undefined
    if (!body || body.sessionId !== sessionId)
      return

    switch (body.type) {
      case 'partial': {
        const delta = body.text.trim()
        if (!delta)
          return
        fullStreamCtrl?.enqueue({ delta, type: 'transcript.text.delta' })
        break
      }
      case 'final': {
        const delta = body.text.trim()
        if (!delta)
          return
        const emitted = `${delta}\n`
        text += emitted
        fullStreamCtrl?.enqueue({ delta: emitted, type: 'transcript.text.delta' })
        textStreamCtrl?.enqueue(emitted)
        break
      }
      case 'finished':
        finish()
        break
      case 'error':
        fail(new Error(body.code ? `${body.code}: ${body.message}` : body.message))
        break
    }
  })

  void (async () => {
    try {
      if (options.abortSignal?.aborted) {
        onAbort()
        return
      }
      options.abortSignal?.addEventListener('abort', onAbort, { once: true })

      await start({
        sessionId,
        apiKey,
        baseUrl: resolveBaseUrl(options),
        model: options.model,
        workspaceId: options.workspaceId,
        sampleRate: options.sampleRate ?? 16000,
        languageHints: options.languageHints,
        vocabularyId: options.vocabularyId,
        maxSentenceSilence: options.maxSentenceSilence,
        semanticPunctuationEnabled: options.semanticPunctuationEnabled,
        punctuationPredictionEnabled: options.punctuationPredictionEnabled,
        inverseTextNormalizationEnabled: options.inverseTextNormalizationEnabled,
        disfluencyRemovalEnabled: options.disfluencyRemovalEnabled,
        multiThresholdModeEnabled: options.multiThresholdModeEnabled,
        heartbeat: options.heartbeat ?? true,
      })

      const reader = audioStream.getReader()
      while (true) {
        if (options.abortSignal?.aborted)
          return

        const { done, value } = await reader.read()
        if (done)
          break
        if (value) {
          context.emit(electronDashScopeAsrClientEvent, {
            sessionId,
            type: 'audio',
            chunk: toUint8Array(value),
          })
        }
      }

      context.emit(electronDashScopeAsrClientEvent, {
        sessionId,
        type: 'finish',
      })
    }
    catch (error) {
      fail(error)
    }
  })()

  return {
    fullStream,
    text: deferredText.promise,
    textStream,
  }
}
