import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { LumiMemoryFragment, LumiMemorySearchRequest } from '@proj-airi/lumi-runtime'

import type { LumiMemoryVectorStatus, LumiServerDatabase } from './database'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

export const DEFAULT_LUMI_MEMORY_EMBEDDING_MODEL = 'BAAI/bge-small-zh-v1.5'

export interface LumiVectorWorkerStatus {
  running: boolean
  model: string
  device: string
  phase?: string
  progress?: string
  lastError?: string
  downloadPercent?: number
}

export interface LumiVectorWorkerOptions {
  workerScriptPath: string
  pythonCommand: string
  /** Arguments placed before the worker script, for example `conda run ... python`. */
  pythonArguments?: string[]
  modelCacheRoot: string
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

  async backfill(limit = 2_000): Promise<LumiMemoryVectorStatus & LumiVectorWorkerStatus> {
    const model = this.worker.status().model
    const memories = this.database.listMemoryVectorCandidates(model, limit)
    const existing = new Map(this.database.memoryVectors(memories.map(memory => memory.id), model).map(vector => [vector.memoryId, vector]))
    const missing = memories.filter(memory => existing.get(memory.id)?.contentDigest !== memoryVectorDigest(memory))
    for (let index = 0; index < missing.length; index += 32) {
      const batch = missing.slice(index, index + 32)
      const vectors = await this.worker.embed(batch.map(memoryVectorText))
      for (let offset = 0; offset < batch.length; offset += 1) {
        const memory = batch[offset]
        const vector = vectors[offset]
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
    return this.status()
  }

  async search(request: LumiMemorySearchRequest, limit = 80): Promise<LumiMemoryFragment[]> {
    const candidates = this.database.listAccessibleMemories(request, Math.min(500, Math.max(limit * 5, limit)))
    if (candidates.length === 0)
      return []
    const [queryVector] = await this.worker.embed([request.query])
    if (!queryVector)
      return candidates.slice(0, limit)
    const vectors = this.database.memoryVectors(candidates.map(memory => memory.id), this.worker.status().model)
    const byId = new Map(vectors.map(vector => [vector.memoryId, vector]))
    return candidates
      .map(memory => ({
        memory,
        score: byId.get(memory.id)?.contentDigest === memoryVectorDigest(memory)
          ? cosineSimilarity(queryVector, byId.get(memory.id)!.vector)
          : -1,
      }))
      .sort((left, right) => right.score - left.score || right.memory.importance - left.memory.importance)
      .slice(0, limit)
      .map(item => item.memory)
  }

  async stop() {
    await this.worker.stop()
  }
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

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length)
    return -1
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! ** 2
    rightNorm += right[index]! ** 2
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1)
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
