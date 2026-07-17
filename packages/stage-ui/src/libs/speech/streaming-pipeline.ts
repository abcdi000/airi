import { getAuthToken } from '../auth'
import { SERVER_URL } from '../server'

/**
 * One synthesized sentence emitted by the streaming pipeline. The pipeline
 * delivers these in arrival order; consumers schedule them into their
 * playback manager directly.
 */
export interface StreamingPipelineSentence {
  /** 0-based sentence index within the session. */
  index: number
  /** Sentence text from the upstream `sentence.*` payload, when available. */
  text: string
  /** Decoded audio. Same `AudioContext` is used for every sentence in the session. */
  audio: AudioBuffer
}

export interface StreamingTtsPipelineEvents {
  /**
   * Fires once per synthesized sentence (TTS 1.0) or once per session
   * (TTS 2.0 / `bufferEntireSession: true`). Schedule the audio into your
   * playback manager from this callback.
   */
  onSentence?: (sentence: StreamingPipelineSentence) => void
  /**
   * Surfaced for any post-upgrade failure (server `error` event, ws close
   * without `session.finished`, decode failure). Consumers should treat the
   * session as terminated after this fires.
   */
  onError?: (err: Error) => void
  /**
   * Fires after the ws closes for any reason. Always paired with either
   * `onSentence` (success path) or `onError` (failure path) preceding it.
   */
  onDone?: () => void
  /**
   * Realtime diagnostics for the chat-side TTS debug panel. This is
   * intentionally a callback instead of a global store dependency so the
   * pipeline stays usable in tests and non-Vue hosts.
   */
  onDebug?: (event: StreamingTtsDebugEvent) => void
}

export interface StreamingTtsPipelineOptions extends StreamingTtsPipelineEvents {
  /** Host-provided id used to correlate generation events with playback. */
  debugSessionId?: string
  /** Server URL override. Defaults to {@link SERVER_URL}. */
  serverUrl?: string
  /** WebSocket path relative to serverUrl. Defaults to AIRI server streaming route. */
  wsPath?: string
  /** Override the auth token (Bearer). Defaults to {@link getAuthToken}. */
  token?: string
  /** Local providers can disable AIRI bearer-token auth for loopback services. */
  requiresAuth?: boolean
  /** unspeech-routed model id, e.g. `volcengine/seed-tts-2.0`. */
  model: string
  /** Upstream voice / speaker id. */
  voice: string
  /** OpenAI-style format. Default `mp3`. */
  responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'pcm' | 'wav'
  /** Backend-specific knobs forwarded as the `extra_body` of the `start` frame. */
  extraBody?: Record<string, unknown>
  /** Optional Qwen-local + cloud-provider hybrid scheduling. */
  hybrid?: HybridStreamingTtsOptions
  /**
   * Decoder context. The pipeline calls `decodeAudioData` on it for each
   * sentence (or once at session end in buffered mode). Reusing the page's
   * AudioContext is required so playback nodes that connect to its
   * destination see compatible sample rates.
   */
  audioContext: BaseAudioContext
  /**
   * When `true`, accumulate every binary chunk until `session.finished` and
   * emit ONE `onSentence`. Use for models where per-sentence audio boundaries
   * are not synchronously aligned with `sentence.end` events (Volcengine
   * Seed-TTS 2.0 ships subtitles asynchronously; chunking on `sentence.end`
   * would drop frames). Default `false` (chunk per sentence — correct for
   * Seed-TTS 1.0 / ICL 1.0 where `sentence.end` arrives in-band with audio).
   */
  bufferEntireSession?: boolean
}

export interface HybridStreamingTtsOptions {
  enabled: boolean
  cloudProviderId?: string
  cloudConfig?: Record<string, unknown>
  firstSegmentMinChars?: number
  segmentMinChars?: number
  localMaxChars?: number
  cloudMaxChars?: number
  cloudMinChars?: number
  cloudMinIntervalMs?: number
  cloudSoftRpm?: number
  cloudMaxRetries?: number
  cloudInitialRetryDelayMs?: number
  cloudCooldownMs?: number
  cloudRequestTimeoutMs?: number
  debug?: boolean
}

export type StreamingTtsDebugLane = 'local' | 'cloud' | 'playback' | 'session'

export type StreamingTtsDebugPhase
  = | 'session_started'
    | 'segment_queued'
    | 'synth_start'
    | 'synth_delay'
    | 'synth_retry'
    | 'synth_ready'
    | 'segment_emitted'
    | 'segment_fallback'
    | 'segment_failed'
    | 'segment_skipped'
    | 'playback_started'
    | 'playback_finished'
    | 'playback_interrupted'
    | 'session_done'
    | 'session_cancelled'

export interface StreamingTtsDebugEvent {
  sessionId: string
  phase: StreamingTtsDebugPhase
  timestamp: number
  lane?: StreamingTtsDebugLane
  segmentIndex?: number
  text?: string
  attempt?: number
  status?: number
  delayMs?: number
  durationMs?: number
  audioDurationMs?: number
  audioBytes?: number
  detail?: string
  error?: string
}

export interface StreamingTtsPipelineHandle {
  /**
   * Forward a chunk of LLM-generated text to the in-flight TTS session.
   * The text is sent verbatim — no client-side segmentation. The upstream
   * model decides where to split sentences and how to pace prosody.
   *
   * Safe to call before the ws is open; frames are queued and flushed
   * after the handshake completes.
   */
  appendText: (text: string) => void
  /**
   * Signal end of the LLM text stream. The upstream emits any remaining
   * audio then `session.finished`; the pipeline closes the ws after.
   */
  finish: () => void
  /**
   * Abort the in-flight session. Sends `cancel` upstream (best-effort, no
   * ack wait per protocol v1) and closes the ws.
   */
  cancel: () => void
}

/**
 * Drives a single bidirectional streaming TTS session for one LLM intent.
 *
 * Use when:
 * - You have a streaming LLM output you want voiced without client-side
 *   sentence segmentation. The upstream model receives raw token chunks
 *   and decides where to split.
 *
 * Expects:
 * - Authenticated user (or `options.token`).
 * - `STREAMING_TTS_UPSTREAM` configKV configured server-side.
 *
 * Returns:
 * - A handle with `appendText` / `finish` / `cancel`. Side-effect: audio
 *   AudioBuffers are emitted via `options.onSentence` in arrival order.
 */
export function createStreamingTtsPipeline(options: StreamingTtsPipelineOptions): StreamingTtsPipelineHandle {
  if (options.hybrid?.enabled)
    return createHybridStreamingTtsPipeline(options)

  const requiresAuth = options.requiresAuth ?? true
  const token = (requiresAuth ? options.token ?? getAuthToken() : options.token) ?? undefined
  if (requiresAuth && !token) {
    const err = new Error('streaming-pipeline: not authenticated')
    queueMicrotask(() => {
      options.onError?.(err)
      options.onDone?.()
    })
    return noopHandle()
  }

  const wsUrl = toWebSocketUrl(options.serverUrl ?? SERVER_URL, options.wsPath ?? '/api/v1/audio/speech/ws', token)
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  let closed = false
  let sawSessionFinished = false
  /**
   * Queue for frames sent before the ws transitions to OPEN. Avoids
   * silently dropping early `appendText` calls (the caller doesn't know
   * the handshake hasn't completed yet).
   */
  const beforeOpenQueue: string[] = []
  /** Binary chunks accumulated since the last sentence flush. */
  let chunks: ArrayBuffer[] = []
  let chunkBytes = 0
  let sentenceIndex = 0
  /**
   * Promise chain for serialized `flushAccumulatedAsSentence` invocations.
   *
   * Each `handleControlFrame` runs via `void handleControlFrame(...)`, so
   * multiple control frames execute concurrently. Without serialization,
   * `session.finished`'s synchronous `chunkBytes === 0` check fires
   * immediately (the prior `sentence.end` already cleared the buffer
   * synchronously before its `await decodeAudioData`), terminating the
   * session before the last sentence's `decodeAudioData` resolves — its
   * `onSentence` then arrives after `terminated = true` in tts-session.ts
   * and gets dropped. Chaining all flushes through this single promise lets
   * `requestTerminate` await the tail before tearing down.
   */
  let pendingFlush: Promise<void> = Promise.resolve()
  let terminationRequested = false
  /**
   * FIFO of sentence texts seen via `sentence.start` events that haven't
   * been paired with a `sentence.end` yet. The protocol promises in-order
   * pairs, but a buggy upstream or re-ordered transport could send two
   * `sentence.start`s in a row; using a queue (instead of a single
   * `pendingSentenceText` variable) keeps each audio buffer labelled with
   * the right text instead of overwriting. Codex review MEDIUM #4.
   */
  const pendingSentenceTexts: string[] = []
  const bufferEntireSession = options.bufferEntireSession ?? false

  function safeSend(payload: string) {
    if (closed)
      return
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload)
      return
    }
    if (ws.readyState === WebSocket.CONNECTING) {
      beforeOpenQueue.push(payload)
    }
    // CLOSING/CLOSED — drop silently; caller will see onDone shortly.
  }

  async function flushCapturedAsSentence(parts: ArrayBuffer[], totalBytes: number, textOverride?: string) {
    if (totalBytes === 0)
      return
    const merged = new Uint8Array(totalBytes)
    let offset = 0
    for (const c of parts) {
      merged.set(new Uint8Array(c), offset)
      offset += c.byteLength
    }

    // Prefer the explicit override (the `sentence.end` payload's own text)
    // over the queued `sentence.start` text — `sentence.end` is the
    // authoritative pairing. The queue covers the case where `sentence.end`
    // arrives without a text field.
    const text = textOverride ?? pendingSentenceTexts.shift() ?? ''

    try {
      // decodeAudioData needs a transferable ArrayBuffer; pass the buffer
      // backing `merged`. Clone to a fresh buffer so subsequent flushes do
      // not race on a buffer the decoder may detach.
      const audio = await options.audioContext.decodeAudioData(merged.buffer.slice(0))
      options.onSentence?.({ index: sentenceIndex++, text, audio })
    }
    catch (err) {
      options.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  function enqueueFlush(textOverride?: string): Promise<void> {
    // `.catch(() => {})` keeps a single decode failure from poisoning the
    // tail of the chain — failures already surface via `onError` inside
    // `flushAccumulatedAsSentence`.
    const parts = chunks
    const totalBytes = chunkBytes
    chunks = []
    chunkBytes = 0
    pendingFlush = pendingFlush.then(() => flushCapturedAsSentence(parts, totalBytes, textOverride)).catch(() => {})
    return pendingFlush
  }

  async function requestTerminate(err: Error | null) {
    if (closed || terminationRequested)
      return
    terminationRequested = true
    // Wait for every queued flush (and its `onSentence` dispatch) to drain
    // before flipping `closed`. Without this await, late-resolving decodes
    // would land after `onDone` has already set `terminated = true` in the
    // consumer adapter and be dropped — that is the "last sentence missing"
    // symptom observed in the wild.
    await pendingFlush
    terminate(err)
  }

  ws.addEventListener('open', () => {
    const startFrame = {
      event: 'start',
      model: options.model,
      voice: options.voice,
      response_format: options.responseFormat ?? 'mp3',
      ...(options.extraBody ? { extra_body: options.extraBody } : {}),
    }
    ws.send(JSON.stringify(startFrame))
    for (const payload of beforeOpenQueue)
      ws.send(payload)
    beforeOpenQueue.length = 0
  })

  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      void handleControlFrame(e.data)
      return
    }
    // binary audio chunk
    if (e.data instanceof ArrayBuffer) {
      chunks.push(e.data)
      chunkBytes += e.data.byteLength
    }
  })

  async function handleControlFrame(raw: string) {
    let evt: { event?: string, payload?: Record<string, unknown>, text?: string, code?: string, message?: string }
    try {
      evt = JSON.parse(raw)
    }
    catch {
      return
    }

    switch (evt.event) {
      case 'sentence.start': {
        // Append to the queue. `sentence.end` consumes from the head, so
        // back-to-back `sentence.start`s (which shouldn't happen but
        // codex MEDIUM #4 noted the race) don't clobber each other.
        const text = readSentenceText(evt.payload)
        if (text != null)
          pendingSentenceTexts.push(text)
        break
      }
      case 'sentence.end': {
        if (bufferEntireSession)
          break
        const text = readSentenceText(evt.payload) ?? pendingSentenceTexts.shift() ?? ''
        // Fire-and-forget into the serialized chain. We do NOT await here;
        // awaiting from the message handler does not block sibling handlers
        // (they run concurrently via `void handleControlFrame`), so an
        // await would only delay this handler's own return without
        // preventing the session.finished race. The chain itself is what
        // enforces ordering.
        void enqueueFlush(text)
        break
      }
      case 'subtitle': {
        // TTS 2.0 emits subtitle events asynchronously (may arrive after
        // the next sentence's audio has already started). We surface the
        // text via the queue but do NOT flush audio here — buffered mode
        // flushes once at session.finished instead.
        const text = readSentenceText(evt.payload)
        if (text != null)
          pendingSentenceTexts.push(text)
        break
      }
      case 'session.finished': {
        sawSessionFinished = true
        void enqueueFlush()
        void requestTerminate(null)
        break
      }
      case 'error': {
        const code = evt.code ?? 'streaming_tts_error'
        const message = evt.message ?? code
        void requestTerminate(new Error(`${code}: ${message}`))
        break
      }
    }
  }

  ws.addEventListener('close', (ev) => {
    if (closed)
      return
    if (sawSessionFinished) {
      // Normal end after `session.finished`; the session.finished handler
      // already enqueued the tail flush and called requestTerminate. Just
      // make sure termination happens even if that path somehow didn't
      // (idempotent — requestTerminate guards against re-entry).
      void requestTerminate(null)
      return
    }
    // Closed before completion: surface as an error so callers don't
    // mistake truncated audio for a successful (short) sentence.
    const reason = ev.reason || `closed_${ev.code}`
    void requestTerminate(new Error(`streaming_tts_closed: ${reason}`))
  })

  ws.addEventListener('error', () => {
    // The `error` event carries no useful info per the WebSocket API; the
    // `close` event right after has the actual reason. Don't double-emit.
  })

  function terminate(err: Error | null) {
    if (closed)
      return
    closed = true
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close()
    }
    catch {}
    if (err != null)
      options.onError?.(err)
    options.onDone?.()
  }

  return {
    appendText(text: string) {
      if (text.length === 0)
        return
      // Pure-whitespace chunks (e.g. the " " between two LLM tokens) ARE
      // forwarded verbatim. Dropping them would corrupt the text the
      // upstream model sees ("hello" + " " + "world" → "helloworld").
      // The per-character billing cost is negligible compared to the
      // semantic risk; codex review LOW #7 noted the wasted units but
      // accepted the trade-off.
      safeSend(JSON.stringify({ event: 'text', text }))
    },
    finish() {
      safeSend(JSON.stringify({ event: 'finish' }))
    },
    cancel() {
      if (closed || terminationRequested)
        return
      safeSend(JSON.stringify({ event: 'cancel' }))
      // Route through `requestTerminate` so any in-flight `decodeAudioData`
      // can still resolve and emit `onSentence` before `onDone` flips the
      // consumer's `terminated` flag. tts-session.ts then runs
      // `stopByIntent` on the playback manager and drops whatever did
      // schedule, so this does NOT prolong playback — it just keeps the
      // termination semantics consistent across cancel / session.finished
      // / error / close paths (codex review).
      void requestTerminate(null)
    },
  }
}

interface HybridSegment {
  fallbackCount: number
  index: number
  text: string
  lane: 'local' | 'cloud'
}

interface HybridReadySegment {
  index: number
  text: string
  lane: 'local' | 'cloud'
  audio: AudioBuffer
}

function createHybridStreamingTtsPipeline(options: StreamingTtsPipelineOptions): StreamingTtsPipelineHandle {
  const hybrid = normalizeHybridOptions(options.hybrid)
  const debugSessionId = options.debugSessionId ?? `hybrid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let closed = false
  let inputFinished = false
  let textBuffer = ''
  let nextSegmentIndex = 0
  let nextEmitIndex = 0
  let localBusy = false
  let cloudBusy = false
  let cloudCooldownUntil = 0
  let cloudLastStartedAt = 0
  const cloudStartedAt: number[] = []
  const localQueue: HybridSegment[] = []
  const cloudQueue: HybridSegment[] = []
  const ready = new Map<number, HybridReadySegment>()
  const failed = new Set<number>()

  function debug(message: string, data?: Record<string, unknown>) {
    if (hybrid.debug)
      console.debug('[Hybrid TTS]', message, data ?? {})
  }

  function emitDebug(event: Omit<StreamingTtsDebugEvent, 'sessionId' | 'timestamp'>) {
    options.onDebug?.({
      sessionId: debugSessionId,
      timestamp: Date.now(),
      ...event,
    })
  }

  emitDebug({
    phase: 'session_started',
    lane: 'session',
    detail: hybrid.cloudProviderId
      ? `hybrid local + ${hybrid.cloudProviderId}`
      : 'hybrid local only',
  })

  function terminate(err: Error | null = null) {
    if (closed)
      return
    closed = true
    emitDebug({
      phase: 'session_done',
      lane: 'session',
      error: err ? String(err.message || err) : undefined,
    })
    if (err)
      options.onError?.(err)
    options.onDone?.()
  }

  function maybeDone() {
    if (!inputFinished || closed)
      return
    if (textBuffer.trim())
      return
    if (localBusy || cloudBusy || localQueue.length > 0 || cloudQueue.length > 0 || ready.size > 0)
      return
    terminate()
  }

  function flushReady() {
    while ((ready.has(nextEmitIndex) || failed.has(nextEmitIndex)) && !closed) {
      if (failed.has(nextEmitIndex)) {
        failed.delete(nextEmitIndex)
        emitDebug({
          phase: 'segment_skipped',
          lane: 'session',
          segmentIndex: nextEmitIndex,
          detail: 'segment failed on both lanes and was skipped to keep the ordered playback queue moving',
        })
        nextEmitIndex += 1
        continue
      }
      const item = ready.get(nextEmitIndex)!
      ready.delete(nextEmitIndex)
      emitDebug({
        phase: 'segment_emitted',
        lane: item.lane,
        segmentIndex: item.index,
        text: item.text,
        audioDurationMs: Math.round((item.audio.duration || 0) * 1000),
      })
      options.onSentence?.({
        index: item.index,
        text: item.text,
        audio: item.audio,
      })
      nextEmitIndex += 1
    }
    maybeDone()
  }

  function markFailed(segment: HybridSegment, err: unknown) {
    failed.add(segment.index)
    emitDebug({
      phase: 'segment_failed',
      lane: segment.lane,
      segmentIndex: segment.index,
      text: segment.text,
      error: err instanceof Error ? err.message : String(err),
    })
    options.onError?.(err instanceof Error ? err : new Error(String(err)))
    flushReady()
  }

  function putReady(segment: HybridSegment, audio: AudioBuffer) {
    ready.set(segment.index, {
      index: segment.index,
      text: segment.text,
      lane: segment.lane,
      audio,
    })
    flushReady()
  }

  function enqueueSegment(text: string) {
    const index = nextSegmentIndex++
    const lane = chooseHybridLane(index, text, hybrid, {
      cloudCooldownUntil,
    })
    const segment: HybridSegment = { fallbackCount: 0, index, text, lane }
    if (lane === 'cloud')
      cloudQueue.push(segment)
    else
      localQueue.push(segment)
    debug('queued', { index, lane, text })
    emitDebug({
      phase: 'segment_queued',
      lane,
      segmentIndex: index,
      text,
    })
    pump()
  }

  function drainSegments(force: boolean) {
    while (!closed) {
      const maxChars = Math.max(hybrid.localMaxChars, hybrid.cloudMaxChars)
      const minChars = nextSegmentIndex === 0 ? hybrid.firstSegmentMinChars : hybrid.segmentMinChars
      const result = takeHybridSegment(textBuffer, {
        force,
        minChars,
        maxChars,
      })
      if (!result)
        break
      textBuffer = result.rest
      if (result.segment.trim())
        enqueueSegment(result.segment)
    }
  }

  function pump() {
    if (!localBusy && localQueue.length > 0) {
      const segment = localQueue.shift()!
      localBusy = true
      const startedAt = Date.now()
      emitDebug({
        phase: 'synth_start',
        lane: 'local',
        segmentIndex: segment.index,
        text: segment.text,
      })
      void synthesizeLocalSegment(options, segment)
        .then((audio) => {
          emitDebug({
            phase: 'synth_ready',
            lane: 'local',
            segmentIndex: segment.index,
            text: segment.text,
            durationMs: Date.now() - startedAt,
            audioDurationMs: Math.round((audio.duration || 0) * 1000),
          })
          putReady(segment, audio)
        })
        .catch((err) => {
          debug('local failed', { index: segment.index, error: String(err) })
          if (hybrid.cloudProviderId && segment.fallbackCount < 1) {
            segment.fallbackCount += 1
            emitDebug({
              phase: 'segment_fallback',
              lane: 'cloud',
              segmentIndex: segment.index,
              text: segment.text,
              detail: 'local failed; retrying on cloud lane',
              error: err instanceof Error ? err.message : String(err),
            })
            segment.lane = 'cloud'
            cloudQueue.unshift(segment)
          }
          else {
            markFailed(segment, err)
          }
        })
        .finally(() => {
          localBusy = false
          pump()
          maybeDone()
        })
    }

    if (!cloudBusy && cloudQueue.length > 0) {
      const segment = cloudQueue.shift()!
      cloudBusy = true
      void synthesizeCloudSegmentWithRetry(segment, hybrid, options.audioContext, debug)
        .then(audio => putReady(segment, audio))
        .catch((err) => {
          debug('cloud failed; falling back local', { index: segment.index, error: String(err) })
          if (segment.fallbackCount < 1) {
            segment.fallbackCount += 1
            emitDebug({
              phase: 'segment_fallback',
              lane: 'local',
              segmentIndex: segment.index,
              text: segment.text,
              detail: 'cloud failed; retrying on local lane',
              error: err instanceof Error ? err.message : String(err),
            })
            segment.lane = 'local'
            localQueue.unshift(segment)
          }
          else {
            markFailed(segment, err)
          }
        })
        .finally(() => {
          cloudBusy = false
          pump()
          maybeDone()
        })
    }
  }

  async function synthesizeCloudSegmentWithRetry(
    segment: HybridSegment,
    settings: Required<HybridStreamingTtsOptions>,
    audioContext: BaseAudioContext,
    debugLog: (message: string, data?: Record<string, unknown>) => void,
  ): Promise<AudioBuffer> {
    let attempt = 0
    while (!closed) {
      await waitForCloudBudget(settings, segment)
      try {
        cloudLastStartedAt = Date.now()
        cloudStartedAt.push(cloudLastStartedAt)
        pruneCloudRpmWindow(cloudStartedAt)
        debugLog('cloud start', { index: segment.index, attempt })
        const startedAt = Date.now()
        emitDebug({
          phase: 'synth_start',
          lane: 'cloud',
          segmentIndex: segment.index,
          text: segment.text,
          attempt,
        })
        const audio = await synthesizeCloudSegment(segment.text, settings, audioContext)
        emitDebug({
          phase: 'synth_ready',
          lane: 'cloud',
          segmentIndex: segment.index,
          text: segment.text,
          attempt,
          durationMs: Date.now() - startedAt,
          audioDurationMs: Math.round((audio.duration || 0) * 1000),
        })
        return audio
      }
      catch (error) {
        const status = readErrorStatus(error)
        if (status === 429)
          cloudCooldownUntil = Date.now() + settings.cloudCooldownMs
        if (isTimeoutLikeError(error))
          throw error
        if (attempt >= settings.cloudMaxRetries)
          throw error
        const delay = retryDelay(settings.cloudInitialRetryDelayMs, attempt, status === 429)
        debugLog('cloud retry', { index: segment.index, attempt, status, delay })
        emitDebug({
          phase: 'synth_retry',
          lane: 'cloud',
          segmentIndex: segment.index,
          text: segment.text,
          attempt,
          status,
          delayMs: delay,
          error: error instanceof Error ? error.message : String(error),
        })
        attempt += 1
        await sleepMs(delay)
      }
    }
    throw new Error('Hybrid TTS session cancelled')
  }

  async function waitForCloudBudget(settings: Required<HybridStreamingTtsOptions>, segment: HybridSegment) {
    while (!closed) {
      pruneCloudRpmWindow(cloudStartedAt)
      const now = Date.now()
      const intervalWait = Math.max(0, cloudLastStartedAt + settings.cloudMinIntervalMs - now)
      const cooldownWait = Math.max(0, cloudCooldownUntil - now)
      const rpmWait = cloudStartedAt.length >= settings.cloudSoftRpm
        ? Math.max(0, 60000 - (now - cloudStartedAt[0]))
        : 0
      const wait = Math.max(intervalWait, cooldownWait, rpmWait)
      if (wait <= 0)
        return
      emitDebug({
        phase: 'synth_delay',
        lane: 'cloud',
        segmentIndex: segment.index,
        text: segment.text,
        delayMs: wait,
        detail: cooldownWait > 0
          ? 'cloud cooldown'
          : rpmWait > 0
            ? 'cloud RPM budget'
            : 'cloud minimum interval',
      })
      await sleepMs(Math.min(wait, 1000))
    }
  }

  return {
    appendText(text: string) {
      if (closed || !text)
        return
      textBuffer += text
      drainSegments(false)
      pump()
    },
    finish() {
      if (closed)
        return
      inputFinished = true
      drainSegments(true)
      pump()
      maybeDone()
    },
    cancel() {
      closed = true
      localQueue.length = 0
      cloudQueue.length = 0
      ready.clear()
      failed.clear()
      emitDebug({
        phase: 'session_cancelled',
        lane: 'session',
      })
      options.onDone?.()
    },
  }
}

function noopHandle(): StreamingTtsPipelineHandle {
  return { appendText: () => {}, finish: () => {}, cancel: () => {} }
}

function toWebSocketUrl(httpBase: string, path: string, token?: string): string {
  const u = new URL(path, httpBase)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  if (token)
    u.searchParams.set('token', token)
  return u.toString()
}

/**
 * Reads the sentence text from a `sentence.start` / `sentence.end` /
 * `subtitle` payload. Returns `null` when the payload doesn't carry one
 * (e.g. final upstream events with empty bodies).
 */
function readSentenceText(payload: Record<string, unknown> | undefined): string | null {
  if (!payload || typeof payload !== 'object')
    return null
  const text = (payload as { text?: unknown }).text
  return typeof text === 'string' ? text : null
}

function normalizeHybridOptions(input: HybridStreamingTtsOptions | undefined): Required<HybridStreamingTtsOptions> {
  return {
    enabled: input?.enabled === true,
    cloudProviderId: input?.cloudProviderId || '',
    cloudConfig: input?.cloudConfig || {},
    firstSegmentMinChars: clampNumber(input?.firstSegmentMinChars, 30, 12, 120),
    segmentMinChars: clampNumber(input?.segmentMinChars, 24, 8, 120),
    localMaxChars: clampNumber(input?.localMaxChars, 70, 24, 220),
    cloudMaxChars: clampNumber(input?.cloudMaxChars, 60, 24, 220),
    cloudMinChars: clampNumber(input?.cloudMinChars, 24, 8, 120),
    cloudMinIntervalMs: clampNumber(input?.cloudMinIntervalMs, 1200, 250, 60000),
    cloudSoftRpm: clampNumber(input?.cloudSoftRpm, 45, 1, 100),
    cloudMaxRetries: clampNumber(input?.cloudMaxRetries, 3, 0, 8),
    cloudInitialRetryDelayMs: clampNumber(input?.cloudInitialRetryDelayMs, 1500, 250, 30000),
    cloudCooldownMs: clampNumber(input?.cloudCooldownMs, 15000, 1000, 120000),
    cloudRequestTimeoutMs: clampNumber(input?.cloudRequestTimeoutMs, 18000, 100, 180000),
    debug: input?.debug === true,
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function chooseHybridLane(
  index: number,
  text: string,
  settings: Required<HybridStreamingTtsOptions>,
  state: {
    cloudCooldownUntil: number
  },
): 'local' | 'cloud' {
  if (index === 0)
    return 'local'
  if (!settings.cloudProviderId || settings.cloudProviderId === 'speech-noop')
    return 'local'
  if (text.trim().length < settings.cloudMinChars)
    return 'local'

  // The hybrid scheduler is a two-lane pipeline, not a "whoever is free
  // steals the next segment" pool:
  //
  //   0 -> local, 1 -> cloud, 2 -> local, 3 -> cloud ...
  //
  // If local is busy, the next local segment waits in the local queue while
  // the current local audio is being generated/played. This keeps the text
  // order stable and avoids the observed failure mode where segment 2 jumps
  // to MiMo just because Qwen is still synthesizing segment 0.
  if (index % 2 === 0)
    return 'local'

  if (Date.now() < state.cloudCooldownUntil)
    return 'local'
  return 'cloud'
}

function takeHybridSegment(
  input: string,
  options: { force: boolean, maxChars: number, minChars: number },
): { segment: string, rest: string } | null {
  const text = input.replace(/^\s+/, '')
  if (!text)
    return null

  const boundary = /[。！？!?；;…]+/g
  let match: RegExpExecArray | null
  while ((match = boundary.exec(text)) != null) {
    const end = match.index + match[0].length
    if (end >= options.minChars && end <= options.maxChars) {
      return {
        segment: text.slice(0, end).trim(),
        rest: text.slice(end),
      }
    }
  }

  if (text.length >= options.maxChars) {
    const slice = text.slice(0, options.maxChars)
    const soft = Math.max(
      slice.lastIndexOf('，'),
      slice.lastIndexOf(','),
      slice.lastIndexOf('、'),
      slice.lastIndexOf(' '),
    )
    const end = soft >= options.minChars ? soft + 1 : options.maxChars
    return {
      segment: text.slice(0, end).trim(),
      rest: text.slice(end),
    }
  }

  if (options.force) {
    return {
      segment: text.trim(),
      rest: '',
    }
  }

  return null
}

async function synthesizeLocalSegment(
  options: StreamingTtsPipelineOptions,
  segment: HybridSegment,
): Promise<AudioBuffer> {
  const url = new URL('audio/speech', options.serverUrl ?? SERVER_URL)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      input: segment.text,
      voice: options.voice,
      response_format: options.responseFormat ?? 'wav',
      extra_body: options.extraBody ?? {},
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Qwen3 local TTS failed: ${res.status}${text ? ` ${text.slice(0, 500)}` : ''}`)
  }
  const audio = await res.arrayBuffer()
  return await options.audioContext.decodeAudioData(audio.slice(0))
}

async function synthesizeCloudSegment(
  text: string,
  settings: Required<HybridStreamingTtsOptions>,
  audioContext: BaseAudioContext,
): Promise<AudioBuffer> {
  switch (settings.cloudProviderId) {
    case 'mimo-audio-speech':
      return await synthesizeMimoSegment(text, settings, audioContext)
    case 'alibaba-cloud-model-studio':
      return await synthesizeDashscopeCosyVoiceSegment(text, settings, audioContext)
    default:
      throw new Error(`Hybrid TTS cloud provider is not supported yet: ${settings.cloudProviderId}`)
  }
}

async function synthesizeMimoSegment(
  text: string,
  settings: Required<HybridStreamingTtsOptions>,
  audioContext: BaseAudioContext,
): Promise<AudioBuffer> {
  const config = settings.cloudConfig
  const apiKey = readString(config.apiKey)
  if (!apiKey)
    throw new Error('MiMo API key is required for Hybrid TTS cloud assistance.')

  const baseUrl = (readString(config.baseUrl) || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
  const model = readString(config.model) || 'mimo-v2.5-tts'
  const format = readString(config.format) || 'wav'
  const stylePrompt = readString(config.stylePrompt)
  const voiceSample = readString(config.voiceSample)
  const audio: Record<string, string> = { format }

  if (model === 'mimo-v2.5-tts-voiceclone') {
    if (!voiceSample)
      throw new Error('MiMo voice clone requires a configured mp3/wav voice sample.')
    audio.voice = voiceSample
  }
  else if (model === 'mimo-v2.5-tts') {
    audio.voice = readString(config.voice) || 'mimo_default'
  }
  else if (model === 'mimo-v2.5-tts-voicedesign' && !stylePrompt) {
    throw new Error('MiMo voice design requires a style prompt.')
  }

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'user', content: stylePrompt },
        { role: 'assistant', content: text },
      ],
      audio,
    }),
  }, settings.cloudRequestTimeoutMs, 'MiMo hybrid TTS')

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`MiMo hybrid TTS failed: ${res.status} ${res.statusText}${body ? ` ${body.slice(0, 500)}` : ''}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }

  const data = await res.json()
  const audioBase64 = data?.choices?.[0]?.message?.audio?.data
  if (typeof audioBase64 !== 'string' || !audioBase64)
    throw new Error('MiMo hybrid TTS response missing audio data.')

  const bytes = base64ToBytes(audioBase64)
  return await audioContext.decodeAudioData(toArrayBuffer(bytes))
}

async function synthesizeDashscopeCosyVoiceSegment(
  text: string,
  settings: Required<HybridStreamingTtsOptions>,
  audioContext: BaseAudioContext,
): Promise<AudioBuffer> {
  const config = settings.cloudConfig
  const apiKey = readString(config.apiKey)
  if (!apiKey)
    throw new Error('DashScope API key is required for Hybrid TTS cloud assistance.')

  const region = readString(config.region) || 'cn'
  const baseUrl = readString(config.baseUrl)
    || (region === 'intl'
      ? 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
      : 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer')
  const model = readString(config.model) || 'cosyvoice-v3.5-flash'
  const voice = readString(config.customVoiceId) || readString(config.voice)
  if (!voice)
    throw new Error('CosyVoice hybrid TTS requires customVoiceId/voice.')

  const format = readString(config.format) || 'wav'
  const input: Record<string, unknown> = {
    text,
    voice,
    format,
    sample_rate: readNumber(config.sampleRate, 24000),
  }

  const rate = readNumber(config.rate, Number.NaN)
  const pitch = readNumber(config.pitch, Number.NaN)
  const volume = readNumber(config.volume, Number.NaN)
  const instruction = readString(config.instruction)
  const languageHint = readString(config.languageHint)
  if (Number.isFinite(rate))
    input.rate = rate
  if (Number.isFinite(pitch))
    input.pitch = pitch
  if (Number.isFinite(volume))
    input.volume = volume
  if (instruction)
    input.instruction = instruction
  if (languageHint)
    input.language_hints = [languageHint]
  if (config.enableSsml === true)
    input.enable_ssml = true

  const res = await fetchWithTimeout(baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(config.streamOutput === true ? { 'X-DashScope-SSE': 'enable' } : {}),
    },
    body: JSON.stringify({
      model,
      input,
    }),
  }, settings.cloudRequestTimeoutMs, 'DashScope CosyVoice hybrid TTS')

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const err = new Error(`DashScope CosyVoice hybrid TTS failed: ${res.status} ${res.statusText}${body ? ` ${body.slice(0, 500)}` : ''}`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }

  const bytes = await readDashscopeCosyVoiceAudioBytes(res, settings.cloudRequestTimeoutMs)
  return await audioContext.decodeAudioData(toArrayBuffer(bytes))
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

async function readDashscopeCosyVoiceAudioBytes(res: Response, timeoutMs: number): Promise<Uint8Array> {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    const text = await res.text()
    const chunks: Uint8Array[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:'))
        continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]')
        continue
      try {
        const json = JSON.parse(payload)
        const audioData = json?.output?.audio?.data
        if (typeof audioData === 'string' && audioData)
          chunks.push(base64ToBytes(audioData))
      }
      catch {}
    }
    if (chunks.length > 0)
      return concatUint8Arrays(chunks)
  }

  const data = await res.json()
  const audioData = data?.output?.audio?.data
  if (typeof audioData === 'string' && audioData)
    return base64ToBytes(audioData)

  const audioUrl = data?.output?.audio?.url
  if (typeof audioUrl !== 'string' || !audioUrl)
    throw new Error(`DashScope CosyVoice response missing output.audio.url/data: ${JSON.stringify(data).slice(0, 500)}`)

  const audioRes = await fetchWithTimeout(audioUrl, {}, timeoutMs, 'DashScope CosyVoice audio download')
  if (!audioRes.ok) {
    const body = await audioRes.text().catch(() => '')
    throw new Error(`DashScope CosyVoice audio download failed: ${audioRes.status}${body ? ` ${body.slice(0, 500)}` : ''}`)
  }
  return new Uint8Array(await audioRes.arrayBuffer())
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(`${label} timed out after ${timeoutMs}ms`), timeoutMs)
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
    })
  }
  catch (error) {
    if (controller.signal.aborted)
      throw new Error(`${label} timed out after ${timeoutMs}ms`)
    throw error
  }
  finally {
    clearTimeout(timeout)
  }
}

function isTimeoutLikeError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError')
    return true
  return error instanceof Error && /timed out|timeout|aborted/i.test(error.message)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function readErrorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error != null && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
    ? (error as { status: number }).status
    : undefined
}

function retryDelay(baseMs: number, attempt: number, rateLimited: boolean): number {
  const multiplier = rateLimited ? 2 : 1
  const jitter = Math.floor(Math.random() * 350)
  return (baseMs * 2 ** attempt * multiplier) + jitter
}

function pruneCloudRpmWindow(startedAt: number[]) {
  const cutoff = Date.now() - 60000
  while (startedAt.length > 0 && startedAt[0] < cutoff)
    startedAt.shift()
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))
}
