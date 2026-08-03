import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { LumiMemoryFragment, LumiMemorySearchRequest } from '@proj-airi/lumi-runtime'

import type {
  LumiMemoryAnnChangeBatch,
  LumiMemoryAnnHead,
  LumiMemoryAnnRecord,
  LumiMemoryVectorStatus,
  LumiServerDatabase,
} from './database'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { errorMessageFrom } from '@moeru/std'
import { LumiQueryEmbeddingCache } from '@proj-airi/lumi-runtime'

export const DEFAULT_LUMI_MEMORY_EMBEDDING_MODEL = 'BAAI/bge-small-zh-v1.5'

export interface LumiVectorWorkerStatus {
  running: boolean
  model: string
  device: string
  phase?: string
  progress?: string
  lastError?: string
  downloadPercent?: number
  annReady?: boolean
  annCount?: number
  annDimensions?: number
  annSequence?: number
  annReason?: string
}

export interface LumiVectorWorkerOptions {
  workerScriptPath: string
  pythonCommand: string
  /** Arguments placed before the worker script, for example `conda run ... python`. */
  pythonArguments?: string[]
  modelCacheRoot: string
  annIndexRoot: string
  bundledModelCacheRoot?: string
  model?: string
  device?: 'auto' | 'cpu' | 'cuda' | 'mps'
  batchSize?: number
  requestTimeoutMs?: number
}

interface WorkerResponse {
  id?: string
  ok: boolean
  result?: unknown
  error?: string
}

interface EmbedResult {
  model: string
  device: string
  dimensions: number
  vectors: number[][]
}

/** Owns the single private Python embedding process used by Lumi Server. */
export class LumiVectorWorker {
  private child?: ChildProcessWithoutNullStreams
  private startPromise?: Promise<ChildProcessWithoutNullStreams>
  private stopping = false
  private requestId = 0
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  private state: LumiVectorWorkerStatus

  constructor(private readonly options: LumiVectorWorkerOptions) {
    this.state = {
      running: false,
      model: options.model ?? DEFAULT_LUMI_MEMORY_EMBEDDING_MODEL,
      device: 'unknown',
    }
  }

  status(): LumiVectorWorkerStatus {
    return { ...this.state }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0)
      return []
    if (texts.length > 2_000 || texts.some(text => typeof text !== 'string' || text.length > 200_000))
      throw new Error('Embedding batch is invalid or too large')
    const params = {
      model: this.state.model,
      texts,
      batchSize: this.options.batchSize ?? 32,
      device: this.options.device ?? 'auto',
    }
    let rawResult: unknown
    try {
      rawResult = await this.request('embed', { ...params, localFilesOnly: true })
    }
    catch {
      this.state = { ...this.state, phase: 'downloading', progress: 'Local vector model is incomplete; checking the configured model source' }
      rawResult = await this.request('embed', { ...params, localFilesOnly: false })
    }
    const result = parseEmbedResult(rawResult)
    this.state.device = result.device
    return result.vectors
  }

  async openAnnIndex(dimensions: number): Promise<AnnIndexStatus> {
    return this.updateAnnStatus(parseAnnIndexStatus(await this.request('ann_open', this.annParams(dimensions))))
  }

  async rebuildAnnIndex(
    head: LumiMemoryAnnHead,
    readPage: (afterMemoryId: string, limit: number) => LumiMemoryAnnRecord[],
  ): Promise<AnnIndexStatus> {
    if (head.dimensions <= 0)
      throw new Error('Cannot rebuild an ANN index without vector dimensions')
    const params = this.annParams(head.dimensions)
    await this.request('ann_rebuild_begin', params)
    try {
      let afterMemoryId = ''
      let added = 0
      while (true) {
        const batch = readPage(afterMemoryId, 512)
        if (batch.length === 0)
          break
        await this.request('ann_rebuild_add', {
          ...params,
          keys: batch.map(record => record.annKey),
          vectors: batch.map(record => record.vector),
        })
        added += batch.length
        afterMemoryId = batch.at(-1)!.memoryId
        if (batch.length < 512)
          break
      }
      if (added !== head.count)
        throw new Error('Authoritative vectors changed during ANN rebuild')
      return this.updateAnnStatus(parseAnnIndexStatus(await this.request('ann_rebuild_commit', {
        ...params,
        sequence: head.sequence,
      })))
    }
    catch (error) {
      await this.request('ann_rebuild_abort', params).catch(() => undefined)
      throw error
    }
  }

  async applyAnnChanges(dimensions: number, changes: LumiMemoryAnnChangeBatch): Promise<AnnIndexStatus> {
    return this.updateAnnStatus(parseAnnIndexStatus(await this.request('ann_apply', {
      ...this.annParams(dimensions),
      keys: changes.upserts.map(record => record.annKey),
      vectors: changes.upserts.map(record => record.vector),
      removeKeys: changes.removeKeys,
      sequence: changes.sequence,
    })))
  }

  async searchAnnIndex(dimensions: number, vector: number[], count: number): Promise<AnnSearchResult> {
    const result = parseAnnSearchResult(await this.request('ann_search', {
      ...this.annParams(dimensions),
      vector,
      count,
    }))
    this.updateAnnStatus(result)
    return result
  }

  noteAnnFailure(error: unknown): void {
    this.state = {
      ...this.state,
      annReady: false,
      annReason: errorMessageFrom(error) ?? 'Unknown ANN failure',
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = undefined
    if (!child) {
      this.state.running = false
      return
    }
    this.rejectPending(new Error('Lumi vector worker is stopping'))
    if (!child.killed)
      child.kill()
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(resolve, 5_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.state.running = false
  }

  private annParams(dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions <= 0)
      throw new Error('ANN dimensions must be a positive integer')
    mkdirSync(this.options.annIndexRoot, { recursive: true })
    const modelDigest = createHash('sha256').update(this.state.model).digest('hex').slice(0, 16)
    return {
      path: join(this.options.annIndexRoot, `${modelDigest}-${dimensions}.usearch`),
      model: this.state.model,
      dimensions,
    }
  }

  private updateAnnStatus(status: AnnIndexStatus): AnnIndexStatus {
    this.state = {
      ...this.state,
      annReady: status.ready,
      annCount: status.count,
      annDimensions: status.dimensions,
      annSequence: status.sequence,
      annReason: status.reason,
    }
    return status
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = await this.ensureStarted()
    const id = `vector_${Date.now().toString(36)}_${++this.requestId}`
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Lumi vector request timed out after ${this.options.requestTimeoutMs ?? 1_800_000}ms`))
      }, this.options.requestTimeoutMs ?? 1_800_000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error)
          return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && !this.child.killed)
      return this.child
    if (this.stopping)
      throw new Error('Lumi vector worker has been stopped')
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = undefined
    })
    return await this.startPromise
  }

  private async start(): Promise<ChildProcessWithoutNullStreams> {
    if (!existsSync(this.options.workerScriptPath))
      throw new Error(`Lumi vector worker script was not found: ${this.options.workerScriptPath}`)
    this.seedBundledModelCache()
    this.state = { ...this.state, phase: 'starting', progress: 'Starting vector service', lastError: undefined }
    const child = spawn(
      this.options.pythonCommand,
      [...(this.options.pythonArguments ?? []), this.options.workerScriptPath],
      {
        cwd: dirname(this.options.workerScriptPath),
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          HF_HOME: this.options.modelCacheRoot,
          HF_HUB_DISABLE_PROGRESS_BARS: '1',
          SENTENCE_TRANSFORMERS_HOME: this.options.modelCacheRoot,
          TQDM_DISABLE: '1',
          LUMI_MEMORY_VECTOR_DEVICE: this.options.device ?? 'auto',
        },
        windowsHide: true,
      },
    )
    this.child = child
    createInterface({ input: child.stdout }).on('line', line => this.handleLine(line))
    child.stderr.on('data', chunk => this.handleStderr(String(chunk)))
    child.on('error', error => this.handleFailure(error))
    child.on('exit', (code, signal) => {
      if (this.child === child)
        this.child = undefined
      this.state.running = false
      if (!this.stopping)
        this.handleFailure(new Error(`Lumi vector worker exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
    try {
      await this.request('health', { model: this.state.model })
      this.state = { ...this.state, running: true, phase: 'ready', progress: 'Vector service ready' }
      return child
    }
    catch (error) {
      if (!child.killed)
        child.kill()
      throw error
    }
  }

  private seedBundledModelCache() {
    const source = this.options.bundledModelCacheRoot
    if (!source || !existsSync(source) || existsSync(this.options.modelCacheRoot))
      return
    mkdirSync(dirname(this.options.modelCacheRoot), { recursive: true })
    cpSync(source, this.options.modelCacheRoot, { recursive: true, force: true })
  }

  private handleLine(line: string) {
    let response: WorkerResponse
    try {
      response = JSON.parse(line) as WorkerResponse
    }
    catch {
      return
    }
    if (!response.id)
      return
    const pending = this.pending.get(response.id)
    if (!pending)
      return
    clearTimeout(pending.timer)
    this.pending.delete(response.id)
    if (response.ok)
      pending.resolve(response.result)
    else
      pending.reject(new Error(response.error || 'Lumi vector worker failed'))
  }

  private handleStderr(chunk: string) {
    for (const line of chunk.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
      const prefix = '[lumi-memory-vector-progress] '
      if (!line.startsWith(prefix))
        continue
      try {
        const progress = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>
        this.state.phase = typeof progress.phase === 'string' ? progress.phase : this.state.phase
        this.state.progress = typeof progress.message === 'string' ? progress.message : this.state.progress
        this.state.device = typeof progress.device === 'string' ? progress.device : this.state.device
        this.state.downloadPercent = finiteNumber(progress.percent)
      }
      catch {
        // Progress diagnostics must never interrupt the request protocol.
      }
    }
  }

  private handleFailure(error: Error) {
    this.state = { ...this.state, running: false, lastError: error.message }
    this.rejectPending(error)
  }

  private rejectPending(error: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }
}

/** Runs semantic memory indexing and search against server-authorized projections. */
export class LumiServerVectorService {
  private readonly queryEmbeddings = new LumiQueryEmbeddingCache()
  private annSynchronization?: Promise<boolean>

  constructor(
    private readonly database: LumiServerDatabase,
    private readonly worker: LumiVectorWorker,
  ) {}

  status(): LumiMemoryVectorStatus & LumiVectorWorkerStatus {
    return {
      ...this.database.memoryVectorStatus(this.worker.status().model, memoryVectorDigest),
      ...this.worker.status(),
    }
  }

  /**
   * Embeds language-retrieval text with the singleton semantic-memory worker.
   *
   * Use when:
   * - Reply expression candidates need semantic vectors
   * - A second model process and model cache must be avoided
   *
   * Returns:
   * - One normalized model vector per input text
   */
  async embedSocialLanguage(texts: string[]) {
    return await this.worker.embed(texts)
  }

  async backfill(limit = 100_000): Promise<LumiMemoryVectorStatus & LumiVectorWorkerStatus> {
    const model = this.worker.status().model
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Vector backfill limit must be a positive integer')
    let scanned = 0
    let offset = 0
    while (scanned < limit) {
      const page = this.database.listMemoryVectorCandidates(model, Math.min(2_000, limit - scanned), offset)
      if (page.length === 0)
        break
      const existing = new Map(this.database.memoryVectors(page.map(memory => memory.id), model).map(vector => [vector.memoryId, vector]))
      const missing = page.filter(memory => existing.get(memory.id)?.contentDigest !== memoryVectorDigest(memory))
      for (let index = 0; index < missing.length; index += 32) {
        const batch = missing.slice(index, index + 32)
        const vectors = await this.worker.embed(batch.map(memoryVectorText))
        for (let batchOffset = 0; batchOffset < batch.length; batchOffset += 1) {
          const memory = batch[batchOffset]
          const vector = vectors[batchOffset]
          if (!memory || !vector)
            throw new Error('Vector worker returned an incomplete batch')
          this.database.upsertMemoryVector({
            memoryId: memory.id,
            model,
            dimensions: vector.length,
            vector,
            contentDigest: memoryVectorDigest(memory),
            device: this.worker.status().device,
            updatedAt: Date.now(),
          })
        }
      }
      scanned += page.length
      offset += page.length
      if (page.length < 2_000)
        break
    }
    await this.synchronizeAnn(true)
    return this.status()
  }

  async search(request: LumiMemorySearchRequest, limit = 80): Promise<LumiMemoryFragment[]> {
    const head = this.database.memoryAnnHead(this.worker.status().model)
    if (head.count === 0 || head.dimensions === 0)
      return []
    try {
      const ready = await withTimeout(this.synchronizeAnn(false), 4_000, 'ANN synchronization')
      if (!ready)
        return []
      const queryVector = await withTimeout(this.queryEmbeddings.resolve(
        this.worker.status().model,
        request.query,
        async () => {
          const [vector] = await this.worker.embed([request.query])
          if (!vector)
            throw new Error('Vector worker returned no query embedding')
          return vector
        },
      ), 4_000, 'query embedding')
      const matches = await withTimeout(this.worker.searchAnnIndex(
        head.dimensions,
        queryVector,
        Math.min(2_000, Math.max(1_024, limit * 32)),
      ), 4_000, 'ANN search')
      const authorized = this.database.authorizedMemoriesForAnn(request, this.worker.status().model, matches.keys)
      const byKey = new Map(authorized.map(item => [item.annKey, item]))
      return matches.keys
        .map((annKey, index) => ({ item: byKey.get(annKey), score: matches.scores[index] ?? -1 }))
        .flatMap(entry => entry.item && entry.item.contentDigest === memoryVectorDigest(entry.item.memory)
          ? [{ item: entry.item, score: entry.score }]
          : [])
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(entry => entry.item.memory)
    }
    catch (error) {
      this.worker.noteAnnFailure(error)
      return []
    }
  }

  async stop() {
    this.queryEmbeddings.clear()
    await this.worker.stop()
  }

  private async synchronizeAnn(allowRebuild: boolean): Promise<boolean> {
    this.annSynchronization ??= this.synchronizeAnnInternal(allowRebuild).finally(() => {
      this.annSynchronization = undefined
    })
    return await this.annSynchronization
  }

  private async synchronizeAnnInternal(allowRebuild: boolean): Promise<boolean> {
    const model = this.worker.status().model
    let head = this.database.memoryAnnHead(model)
    const rebuild = () => {
      const rebuildHead = this.database.memoryAnnHead(model)
      return this.worker.rebuildAnnIndex(
        rebuildHead,
        (afterMemoryId, limit) => this.database.memoryAnnRecords(model, afterMemoryId, limit),
      )
    }
    if (head.count === 0 || head.dimensions === 0)
      return false
    let status = await this.worker.openAnnIndex(head.dimensions)
    if (!status.ready) {
      if (!allowRebuild)
        return false
      status = await rebuild()
      head = this.database.memoryAnnHead(model)
    }
    if (status.sequence > head.sequence || status.dimensions !== head.dimensions) {
      if (!allowRebuild)
        return false
      status = await rebuild()
      head = this.database.memoryAnnHead(model)
    }

    let processedChanges = 0
    while (true) {
      head = this.database.memoryAnnHead(model)
      if (status.sequence >= head.sequence)
        break
      const changes = this.database.memoryAnnChanges(model, status.sequence)
      if (changes.sequence === status.sequence || (processedChanges >= 2_000 && changes.hasMore)) {
        if (!allowRebuild)
          return false
        status = await rebuild()
        head = this.database.memoryAnnHead(model)
        break
      }
      status = await this.worker.applyAnnChanges(head.dimensions, changes)
      processedChanges += changes.upserts.length + changes.removeKeys.length
    }

    head = this.database.memoryAnnHead(model)
    if (status.count !== head.count) {
      if (!allowRebuild)
        return false
      status = await rebuild()
      head = this.database.memoryAnnHead(model)
    }
    return status.ready && status.sequence === head.sequence && status.count === head.count
  }
}

interface AnnIndexStatus {
  ready: boolean
  needsRebuild: boolean
  model: string
  dimensions: number
  sequence: number
  count: number
  reason?: string
}

interface AnnSearchResult extends AnnIndexStatus {
  keys: number[]
  scores: number[]
}

export function memoryVectorText(memory: LumiMemoryFragment): string {
  return [
    `type: ${memory.type}`,
    memory.tags.length ? `tags: ${memory.tags.join(', ')}` : '',
    `content: ${memory.content}`,
  ].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim()
}

export function memoryVectorDigest(memory: LumiMemoryFragment): string {
  return createHash('sha256').update(memoryVectorText(memory)).digest('hex')
}

function parseEmbedResult(value: unknown): EmbedResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Vector worker returned an invalid response')
  const record = value as Record<string, unknown>
  const vectors = record.vectors
  if (!Array.isArray(vectors))
    throw new Error('Vector worker response has no vectors')
  const normalized = vectors.map(finiteVector)
  return {
    model: typeof record.model === 'string' ? record.model : DEFAULT_LUMI_MEMORY_EMBEDDING_MODEL,
    device: typeof record.device === 'string' ? record.device : 'unknown',
    dimensions: typeof record.dimensions === 'number' ? record.dimensions : normalized[0]?.length ?? 0,
    vectors: normalized,
  }
}

function finiteVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'number' && Number.isFinite(item)))
    throw new Error('Vector worker returned a non-finite vector')
  return value
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseAnnIndexStatus(value: unknown): AnnIndexStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Vector worker returned an invalid ANN status')
  const record = value as Record<string, unknown>
  return {
    ready: record.ready === true,
    needsRebuild: record.needsRebuild === true,
    model: typeof record.model === 'string' ? record.model : '',
    dimensions: finiteInteger(record.dimensions, 'ANN dimensions'),
    sequence: finiteInteger(record.sequence, 'ANN sequence'),
    count: finiteInteger(record.count, 'ANN count'),
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  }
}

function parseAnnSearchResult(value: unknown): AnnSearchResult {
  const status = parseAnnIndexStatus(value)
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.keys) || !Array.isArray(record.scores) || record.keys.length !== record.scores.length)
    throw new Error('Vector worker returned invalid ANN matches')
  return {
    ...status,
    keys: record.keys.map(value => finiteInteger(value, 'ANN key')),
    scores: record.scores.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('Vector worker returned a non-finite ANN score')
      return value
    }),
  }
}

function finiteInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer`)
  return value
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
