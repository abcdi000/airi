import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { DashScopeAsrClientEvent, DashScopeAsrServerEvent, DashScopeAsrStartPayload } from '@proj-airi/stage-shared'

import { defineInvokeHandler } from '@moeru/eventa'
import { electronDashScopeAsrClientEvent, electronDashScopeAsrServerEvent, electronDashScopeAsrStart } from '@proj-airi/stage-shared'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

interface NodeWebSocket {
  readonly readyState: number
  close: (code?: number, reason?: string) => void
  on: {
    (event: 'open', listener: () => void): NodeWebSocket
    (event: 'message', listener: (raw: Buffer | string | ArrayBuffer) => void): NodeWebSocket
    (event: 'error', listener: (error: unknown) => void): NodeWebSocket
    (event: 'close', listener: (code: number, reason: Buffer) => void): NodeWebSocket
  }
  send: (data: string | Buffer) => void
}

interface NodeWebSocketConstructor {
  readonly CONNECTING: number
  readonly OPEN: number
  new(url: string, options?: { headers?: Record<string, string> }): NodeWebSocket
}

const require = createRequire(import.meta.url)
const { WebSocket } = loadWebSocketPackage()

function loadWebSocketPackage() {
  try {
    return require('ws') as { WebSocket: NodeWebSocketConstructor }
  }
  catch {
    const packagePath = findWebSocketPackagePath()
    if (!packagePath)
      throw new Error('Cannot find the ws package required by DashScope realtime ASR. Please run pnpm install in the AIRI workspace.')
    return require(packagePath) as { WebSocket: NodeWebSocketConstructor }
  }
}

function findWebSocketPackagePath() {
  const visited = new Set<string>()
  const starts = [
    dirname(fileURLToPath(import.meta.url)),
    typeof process !== 'undefined' ? process.cwd() : '',
  ].filter(Boolean)

  for (const start of starts) {
    let current = start
    const root = parse(current).root
    while (current && !visited.has(current)) {
      visited.add(current)

      const direct = join(current, 'node_modules', 'ws')
      if (existsSync(join(direct, 'index.js')))
        return direct

      const pnpmRoot = join(current, 'node_modules', '.pnpm')
      if (existsSync(pnpmRoot)) {
        const match = readdirSync(pnpmRoot, { withFileTypes: true })
          .filter(entry => entry.isDirectory() && entry.name.startsWith('ws@'))
          .map(entry => join(pnpmRoot, entry.name, 'node_modules', 'ws'))
          .find(path => existsSync(join(path, 'index.js')))
        if (match)
          return match
      }

      if (current === root)
        break
      current = dirname(current)
    }
  }
}

interface DashScopeAsrSession {
  payload: DashScopeAsrStartPayload
  ws: NodeWebSocket
  started: boolean
  pendingAudio: Uint8Array[]
  closed: boolean
}

type EventaContext = ReturnType<typeof createContext>['context']

const DEFAULT_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
const DEFAULT_SAMPLE_RATE = 16000

export function createDashScopeAsrService(params: { context: EventaContext }) {
  const sessions = new Map<string, DashScopeAsrSession>()

  const emit = (event: DashScopeAsrServerEvent) => {
    params.context.emit(electronDashScopeAsrServerEvent, event)
  }

  function closeSession(sessionId: string, reason?: string) {
    const session = sessions.get(sessionId)
    if (!session)
      return

    session.closed = true
    sessions.delete(sessionId)

    try {
      if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING)
        session.ws.close(1000, reason || 'client closed')
    }
    catch {}
  }

  function sendFinish(session: DashScopeAsrSession) {
    if (session.ws.readyState !== WebSocket.OPEN)
      return

    session.ws.send(JSON.stringify({
      header: {
        action: 'finish-task',
        task_id: session.payload.sessionId,
        streaming: 'duplex',
      },
      payload: {
        input: {},
      },
    }))
  }

  function flushPendingAudio(session: DashScopeAsrSession) {
    if (!session.started || session.ws.readyState !== WebSocket.OPEN)
      return

    const chunks = session.pendingAudio.splice(0)
    for (const chunk of chunks)
      session.ws.send(Buffer.from(chunk))
  }

  function sendAudio(session: DashScopeAsrSession, chunk: Uint8Array) {
    if (session.closed)
      return
    if (!session.started || session.ws.readyState !== WebSocket.OPEN) {
      session.pendingAudio.push(chunk)
      return
    }
    session.ws.send(Buffer.from(chunk))
  }

  function startSession(payload: DashScopeAsrStartPayload) {
    const apiKey = payload.apiKey.trim()
    if (!apiKey)
      throw new Error('DashScope ASR API Key is required.')

    const baseUrl = payload.baseUrl.trim() || DEFAULT_BASE_URL
    const ws = new WebSocket(baseUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'user-agent': 'AIRI-Lumi-DashScope-ASR',
        ...(payload.workspaceId?.trim() ? { 'X-DashScope-WorkSpace': payload.workspaceId.trim() } : {}),
      },
    })

    const session: DashScopeAsrSession = {
      payload,
      ws,
      started: false,
      pendingAudio: [],
      closed: false,
    }
    sessions.set(payload.sessionId, session)

    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: {
          action: 'run-task',
          task_id: payload.sessionId,
          streaming: 'duplex',
        },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: payload.model,
          parameters: {
            format: 'pcm',
            sample_rate: payload.sampleRate ?? DEFAULT_SAMPLE_RATE,
            ...(payload.languageHints?.length ? { language_hints: payload.languageHints } : {}),
            ...(payload.vocabularyId?.trim() ? { vocabulary_id: payload.vocabularyId.trim() } : {}),
            ...(typeof payload.maxSentenceSilence === 'number' ? { max_sentence_silence: payload.maxSentenceSilence } : {}),
            ...(typeof payload.semanticPunctuationEnabled === 'boolean' ? { semantic_punctuation_enabled: payload.semanticPunctuationEnabled } : {}),
            ...(typeof payload.punctuationPredictionEnabled === 'boolean' ? { punctuation_prediction_enabled: payload.punctuationPredictionEnabled } : {}),
            ...(typeof payload.inverseTextNormalizationEnabled === 'boolean' ? { inverse_text_normalization_enabled: payload.inverseTextNormalizationEnabled } : {}),
            ...(typeof payload.disfluencyRemovalEnabled === 'boolean' ? { disfluency_removal_enabled: payload.disfluencyRemovalEnabled } : {}),
            ...(typeof payload.multiThresholdModeEnabled === 'boolean' ? { multi_threshold_mode_enabled: payload.multiThresholdModeEnabled } : {}),
            ...(typeof payload.heartbeat === 'boolean' ? { heartbeat: payload.heartbeat } : {}),
          },
          input: {},
        },
      }))
    })

    ws.on('message', (raw) => {
      let message: any
      try {
        message = JSON.parse(raw.toString())
      }
      catch {
        return
      }

      const event = message?.header?.event
      switch (event) {
        case 'task-started':
          session.started = true
          emit({ sessionId: payload.sessionId, type: 'started' })
          flushPendingAudio(session)
          break
        case 'result-generated': {
          const sentence = message?.payload?.output?.sentence
          const text = typeof sentence?.text === 'string' ? sentence.text : ''
          if (!text || sentence?.heartbeat === true)
            return

          emit({
            sessionId: payload.sessionId,
            type: sentence?.sentence_end === true ? 'final' : 'partial',
            text,
            sentenceId: typeof sentence?.sentence_id === 'number' ? sentence.sentence_id : undefined,
          })
          break
        }
        case 'task-finished':
          emit({ sessionId: payload.sessionId, type: 'finished' })
          closeSession(payload.sessionId, 'task finished')
          break
        case 'task-failed':
          emit({
            sessionId: payload.sessionId,
            type: 'error',
            code: typeof message?.header?.error_code === 'string' ? message.header.error_code : undefined,
            message: typeof message?.header?.error_message === 'string' ? message.header.error_message : 'DashScope ASR task failed.',
          })
          closeSession(payload.sessionId, 'task failed')
          break
      }
    })

    ws.on('error', (error) => {
      emit({ sessionId: payload.sessionId, type: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    ws.on('close', (code, reason) => {
      if (!sessions.has(payload.sessionId))
        return
      sessions.delete(payload.sessionId)
      if (code === 1000) {
        emit({ sessionId: payload.sessionId, type: 'finished' })
        return
      }

      emit({
        sessionId: payload.sessionId,
        type: 'error',
        message: `DashScope ASR websocket closed: ${code}${reason?.length ? ` ${reason.toString()}` : ''}`,
      })
    })
  }

  defineInvokeHandler(params.context, electronDashScopeAsrStart, (payload) => {
    closeSession(payload.sessionId, 'restart')
    startSession(payload)
    return {
      sessionId: payload.sessionId,
      accepted: true,
    }
  })

  params.context.on(electronDashScopeAsrClientEvent, ({ body }: { body?: DashScopeAsrClientEvent }) => {
    const event = body
    if (!event)
      return
    const session = sessions.get(event.sessionId)
    if (!session)
      return

    switch (event.type) {
      case 'audio':
        sendAudio(session, event.chunk)
        break
      case 'finish':
        sendFinish(session)
        break
      case 'abort':
        closeSession(event.sessionId, event.reason)
        break
    }
  })

  return {
    closeAll() {
      for (const sessionId of sessions.keys())
        closeSession(sessionId, 'service disposed')
    },
  }
}
