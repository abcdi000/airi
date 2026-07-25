import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

import { errorMessageFrom } from '@moeru/std'

export interface LumiStickerLibraryConfig {
  enabled: boolean
  collectFromStudyGroups: boolean
  relativePath: string
  maximumItems: number
  sendProbability: number
  cooldownMessages: number
}

export interface LumiStickerLibraryStats {
  total: number
  owned: number
  discarded: number
  received: number
  sent: number
}

export interface LumiStickerMonitorEvent {
  id: string
  kind: 'collected' | 'duplicate' | 'discarded' | 'sent' | 'warning'
  stickerId?: string
  sourceId?: string
  timestamp: number
  detail: string
}

/**
 * Supplies consciousness-model judgments for sticker learning and selection.
 *
 * Implementations must not replace model failures with keyword inference.
 */
export interface LumiStickerIntelligence {
  /** Interprets observed conversation context without guessing unseen pixels. */
  classify: (input: {
    senderName: string
    contextText: string
    previousTags: string[]
  }) => Promise<{
    tags: string[]
    summary: string
    confidence: number
  }>
  /** Chooses one supplied candidate or deliberately returns no sticker ID. */
  select: (input: {
    inputText: string
    replyText: string
    candidates: Array<{
      id: string
      tags: string[]
      observedCount: number
      sentCount: number
    }>
  }) => Promise<{ stickerId?: string, reason: string }>
}

export interface LumiStickerRecord {
  id: string
  hash: string
  relativePath: string
  mimeType: string
  status: 'owned' | 'discarded'
  tags: string[]
  tagsManuallyEdited?: boolean
  sourceIds: string[]
  observedCount: number
  sentCount: number
  createdAt: number
  lastObservedAt: number
  lastSentAt?: number
}

interface StickerIndex {
  version: 3
  records: LumiStickerRecord[]
  recentEvents: LumiStickerMonitorEvent[]
  sourceContexts: Record<string, Array<{ text: string, timestamp: number }>>
  replyCounter: number
  lastSentReplyCounter: number
}

export interface CollectedStickerInput {
  dataBase64: string
  mimeType: string
  sourceId: string
  senderName: string
  contextText: string
  timestamp: number
}

export interface SelectedSticker {
  id: string
  dataBase64: string
  mimeType: SupportedImageMime
  tags: string[]
}

type SupportedImageMime = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp'

const EMPTY_INDEX: StickerIndex = {
  version: 3,
  records: [],
  recentEvents: [],
  sourceContexts: {},
  replyCounter: 0,
  lastSentReplyCounter: -1_000_000,
}

/**
 * Owns Lumi's learned sticker files and bounded send-attempt policy.
 *
 * Use when:
 * - Learning image reactions from authorized read-only groups
 * - Selecting an already-owned sticker for an AstrBot reply
 *
 * Expects:
 * - `relativePath` remains below the writable Lumi root
 * - Media bytes have already passed the integration request-size limit
 *
 * Returns:
 * - SHA-256 deduplicated files and a bounded JSON metadata index
 */
export class LumiStickerLibrary {
  private loadedRoot = ''
  private index: StickerIndex = structuredClone(EMPTY_INDEX)
  private queue = Promise.resolve()

  constructor(
    private readonly getConfig: () => LumiStickerLibraryConfig,
    private readonly resolveBaseRoot: () => string,
    private readonly intelligence?: LumiStickerIntelligence,
  ) {}

  async observeContext(sourceId: string, text: string, timestamp: number) {
    await this.serial(async () => {
      const normalized = text.trim()
      if (!normalized)
        return
      const root = await this.ensureLoaded()
      this.index.sourceContexts[sourceId] = [
        ...(this.index.sourceContexts[sourceId] ?? []),
        { text: normalized.slice(0, 1_000), timestamp },
      ].slice(-8)
      await this.persist(root)
    })
  }

  async collect(input: CollectedStickerInput) {
    return await this.serial(async () => {
      const config = this.getConfig()
      if (!config.enabled || !config.collectFromStudyGroups)
        return
      const root = await this.ensureLoaded()
      const bytes = decodeImage(input.dataBase64, input.mimeType)
      const hash = createHash('sha256').update(bytes).digest('hex')
      const directContext = input.contextText.trim()
      const contextualText = directContext || (this.index.sourceContexts[input.sourceId] ?? [])
        .filter(item =>
          item.timestamp <= input.timestamp
          && input.timestamp - item.timestamp <= contextAgeLimit(input.timestamp),
        )
        .slice(-2)
        .map(item => item.text)
        .join('\n')
      const existing = this.index.records.find(record => record.hash === hash)
      if (existing) {
        const classification = await this.classifyContext(input, contextualText, existing.tags)
        existing.observedCount += 1
        existing.lastObservedAt = input.timestamp
        existing.sourceIds = unique([...existing.sourceIds, input.sourceId])
        if (!existing.tagsManuallyEdited)
          existing.tags = unique([...existing.tags, ...classification.tags])
        this.recordEvent({
          kind: 'duplicate',
          stickerId: existing.id,
          sourceId: input.sourceId,
          timestamp: input.timestamp,
          detail: `${input.senderName} 又使用了这张表情，累计观察 ${existing.observedCount} 次`,
        })
        await this.persist(root)
        return
      }

      if (this.index.records.filter(record => record.status === 'owned').length >= config.maximumItems)
        await this.discardLeastUseful(root, input.timestamp)

      const id = randomUUID()
      const extension = extensionForMime(input.mimeType)
      const relativePath = `files/${hash}${extension}`
      await mkdir(resolve(root, 'files'), { recursive: true })
      await writeFile(resolve(root, relativePath), bytes)
      const classification = await this.classifyContext(input, contextualText, [])
      const tags = classification.tags
      this.index.records.push({
        id,
        hash,
        relativePath,
        mimeType: normalizedImageMime(input.mimeType),
        status: 'owned',
        tags,
        sourceIds: [input.sourceId],
        observedCount: 1,
        sentCount: 0,
        createdAt: input.timestamp,
        lastObservedAt: input.timestamp,
      })
      this.recordEvent({
        kind: 'collected',
        stickerId: id,
        sourceId: input.sourceId,
        timestamp: input.timestamp,
        detail: tags.length
          ? `${input.senderName} 的表情已收藏，意识归纳：${tags.join('、')}`
          : `${input.senderName} 的表情已收藏，等待意识模型获得足够语境`,
      })
      await this.persist(root)
    })
  }

  async selectForReply(input: { eventId: string, inputText: string, replyText: string }) {
    return await this.serial(async (): Promise<SelectedSticker | null> => {
      const config = this.getConfig()
      if (!config.enabled)
        return null
      const root = await this.ensureLoaded()
      this.index.replyCounter += 1
      const cooldownElapsed = this.index.replyCounter - this.index.lastSentReplyCounter >= config.cooldownMessages
      const threshold = stableFraction(input.eventId)
      const shouldSend = cooldownElapsed && threshold < config.sendProbability
      if (!shouldSend) {
        await this.persist(root)
        return null
      }

      const candidates = this.index.records
        .filter(record => record.status === 'owned' && record.tags.length > 0)
      if (!candidates.length || !this.intelligence) {
        await this.persist(root)
        return null
      }
      let selected: LumiStickerRecord | undefined
      try {
        const decision = await this.intelligence.select({
          inputText: input.inputText,
          replyText: input.replyText,
          candidates: candidates.map(record => ({
            id: record.id,
            tags: record.tags,
            observedCount: record.observedCount,
            sentCount: record.sentCount,
          })),
        })
        selected = candidates.find(record => record.id === decision.stickerId)
      }
      catch (error) {
        this.recordEvent({
          kind: 'warning',
          timestamp: Date.now(),
          detail: `意识模型未完成表情选择：${errorMessageFrom(error) ?? '未知错误'}`,
        })
      }
      if (!selected) {
        await this.persist(root)
        return null
      }

      let data: Buffer
      try {
        data = await readFile(resolveStoredPath(root, selected.relativePath))
      }
      catch {
        selected.status = 'discarded'
        this.recordEvent({
          kind: 'warning',
          stickerId: selected.id,
          timestamp: Date.now(),
          detail: '表情文件缺失，已从可发送库移除',
        })
        await this.persist(root)
        return null
      }

      selected.sentCount += 1
      selected.lastSentAt = Date.now()
      this.index.lastSentReplyCounter = this.index.replyCounter
      this.recordEvent({
        kind: 'sent',
        stickerId: selected.id,
        timestamp: selected.lastSentAt,
        detail: selected.tags.length
          ? `已按当前语境发送：${selected.tags.join('、')}`
          : '已发送一张已收藏表情',
      })
      await this.persist(root)
      return {
        id: selected.id,
        dataBase64: data.toString('base64'),
        mimeType: normalizedImageMime(selected.mimeType),
        tags: selected.tags,
      }
    })
  }

  async snapshot() {
    const root = await this.ensureLoaded()
    return this.snapshotUnlocked(root)
  }

  /**
   * Reads one sticker for an on-demand management preview.
   *
   * Use when:
   * - A settings surface needs to preview an individual library record
   *
   * Expects:
   * - The record ID came from {@link snapshot}
   *
   * Returns:
   * - Image bytes and MIME type without placing the complete library in IPC state
   */
  async readPreview(id: string) {
    return await this.serial(async () => {
      const root = await this.ensureLoaded()
      const record = this.index.records.find(item => item.id === id)
      if (!record)
        return null
      const data = await readFile(resolveStoredPath(root, record.relativePath))
      return {
        id: record.id,
        dataBase64: data.toString('base64'),
        mimeType: normalizedImageMime(record.mimeType),
      }
    })
  }

  /**
   * Updates user-managed sticker metadata.
   *
   * Use when:
   * - Correcting model-produced tags
   * - Restoring or discarding a sticker without deleting its metadata
   *
   * Expects:
   * - Tags are human-authored labels and status is a supported library state
   *
   * Returns:
   * - The refreshed lightweight library snapshot
   */
  async updateRecord(id: string, patch: { tags?: string[], status?: 'owned' | 'discarded' }) {
    return await this.serial(async () => {
      const root = await this.ensureLoaded()
      const record = this.index.records.find(item => item.id === id)
      if (!record)
        throw new Error('Sticker record not found')
      if (patch.tags)
        record.tags = unique(patch.tags).filter(tag => tag.length <= 24).slice(0, 12)
      if (patch.tags)
        record.tagsManuallyEdited = true
      if (patch.status)
        record.status = patch.status
      await this.persist(root)
      return this.snapshotUnlocked(root)
    })
  }

  /**
   * Permanently removes one sticker and its stored image.
   *
   * Use when:
   * - A library owner confirms that an unsuitable sticker should be deleted
   *
   * Expects:
   * - The caller has already requested destructive-action confirmation
   *
   * Returns:
   * - The refreshed lightweight library snapshot
   */
  async deleteRecord(id: string) {
    return await this.serial(async () => {
      const root = await this.ensureLoaded()
      const record = this.index.records.find(item => item.id === id)
      if (!record)
        throw new Error('Sticker record not found')
      await unlink(resolveStoredPath(root, record.relativePath)).catch(() => undefined)
      this.index.records = this.index.records.filter(item => item.id !== id)
      await this.persist(root)
      return this.snapshotUnlocked(root)
    })
  }

  private snapshotUnlocked(root: string) {
    const records = this.index.records
    const stats: LumiStickerLibraryStats = {
      total: records.length,
      owned: records.filter(record => record.status === 'owned').length,
      discarded: records.filter(record => record.status === 'discarded').length,
      received: records.reduce((total, record) => total + record.observedCount, 0),
      sent: records.reduce((total, record) => total + record.sentCount, 0),
    }
    return {
      rootPath: root,
      stats,
      records: records.map(record => ({ ...record, tags: [...record.tags], sourceIds: [...record.sourceIds] })),
      recentEvents: [...this.index.recentEvents].reverse(),
    }
  }

  private async ensureLoaded() {
    const root = resolveLibraryRoot(
      this.getConfig().relativePath,
      this.resolveBaseRoot(),
    )
    if (root === this.loadedRoot)
      return root
    await mkdir(root, { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(resolve(root, 'index.json'), 'utf8')) as Partial<StickerIndex> & { version?: number }
      const migratedFromRuleBasedTags = parsed.version !== 3
      this.index = {
        version: 3,
        records: Array.isArray(parsed.records)
          ? parsed.records.map(record => migratedFromRuleBasedTags ? { ...record, tags: [] } : record)
          : [],
        recentEvents: migratedFromRuleBasedTags
          ? [{
              id: randomUUID(),
              kind: 'warning',
              timestamp: Date.now(),
              detail: '已清除旧版规则标签；图片保留，等待 Lumi 意识模型重新归纳',
            }]
          : Array.isArray(parsed.recentEvents) ? parsed.recentEvents.slice(-100) : [],
        sourceContexts: !migratedFromRuleBasedTags && parsed.sourceContexts && typeof parsed.sourceContexts === 'object'
          ? parsed.sourceContexts
          : {},
        replyCounter: Number.isInteger(parsed.replyCounter) ? parsed.replyCounter! : 0,
        lastSentReplyCounter: Number.isInteger(parsed.lastSentReplyCounter) ? parsed.lastSentReplyCounter! : -1_000_000,
      }
    }
    catch {
      this.index = structuredClone(EMPTY_INDEX)
    }
    this.loadedRoot = root
    return root
  }

  private async discardLeastUseful(root: string, timestamp: number) {
    const target = this.index.records
      .filter(record => record.status === 'owned')
      .sort((left, right) =>
        left.sentCount - right.sentCount
        || left.observedCount - right.observedCount
        || left.lastObservedAt - right.lastObservedAt,
      )[0]
    if (!target)
      return
    target.status = 'discarded'
    await unlink(resolveStoredPath(root, target.relativePath)).catch(() => undefined)
    this.recordEvent({
      kind: 'discarded',
      stickerId: target.id,
      timestamp,
      detail: '表情库已满，已淘汰使用和观察频率最低的一张',
    })
  }

  private async classifyContext(
    input: CollectedStickerInput,
    contextText: string,
    previousTags: string[],
  ) {
    if (!contextText.trim() || !this.intelligence)
      return { tags: [] as string[], summary: '', confidence: 0 }
    try {
      const result = await this.intelligence.classify({
        senderName: input.senderName,
        contextText,
        previousTags,
      })
      return {
        tags: unique(result.tags).filter(tag => tag.length <= 24).slice(0, 5),
        summary: result.summary.trim().slice(0, 240),
        confidence: Math.min(1, Math.max(0, result.confidence)),
      }
    }
    catch (error) {
      this.recordEvent({
        kind: 'warning',
        sourceId: input.sourceId,
        timestamp: input.timestamp,
        detail: `意识模型未完成表情归纳：${errorMessageFrom(error) ?? '未知错误'}`,
      })
      return { tags: [] as string[], summary: '', confidence: 0 }
    }
  }

  private recordEvent(event: Omit<LumiStickerMonitorEvent, 'id'>) {
    this.index.recentEvents = [
      ...this.index.recentEvents,
      { id: randomUUID(), ...event },
    ].slice(-100)
  }

  private async persist(root: string) {
    const target = resolve(root, 'index.json')
    const temporary = resolve(root, 'index.json.tmp')
    await writeFile(temporary, `${JSON.stringify(this.index, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.then(() => undefined, () => undefined)
    return await next
  }
}

function resolveLibraryRoot(configuredPath: string, base: string) {
  const normalized = configuredPath.trim().replaceAll('\\', '/')
  if (!normalized || isAbsolute(normalized) || normalized.split('/').includes('..'))
    throw new Error('Lumi sticker library path must be a safe relative path')
  const root = resolve(base, normalized)
  const escaped = relative(base, root)
  if (escaped.startsWith('..') || isAbsolute(escaped))
    throw new Error('Lumi sticker library path escapes the writable root')
  return root
}

function resolveStoredPath(root: string, storedPath: string) {
  const target = resolve(root, storedPath)
  const escaped = relative(root, target)
  if (escaped.startsWith('..') || isAbsolute(escaped))
    throw new Error('Stored sticker path escapes the library root')
  return target
}

function decodeImage(encoded: string, declaredMime: string) {
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new Error('Sticker image size is invalid')
  const detected = detectImageMime(bytes)
  if (!detected || detected !== normalizedImageMime(declaredMime))
    throw new Error('Sticker MIME type does not match its bytes')
  return bytes
}

function detectImageMime(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)
    return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')))
    return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    return 'image/webp'
  return undefined
}

function normalizedImageMime(mime: string): SupportedImageMime {
  const value = mime.split(';', 1)[0]!.trim().toLocaleLowerCase()
  if (value === 'image/jpg')
    return 'image/jpeg'
  if (value === 'image/gif' || value === 'image/jpeg' || value === 'image/png' || value === 'image/webp')
    return value
  throw new Error(`Unsupported sticker MIME type: ${value || 'unknown'}`)
}

function extensionForMime(mime: string) {
  return ({
    'image/gif': '.gif',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  })[normalizedImageMime(mime)]
}

function stableFraction(value: string) {
  return Number.parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16) / 0xFFFFFFFF
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function contextAgeLimit(timestamp: number) {
  return timestamp >= 1_000_000_000_000 ? 45_000 : 45
}
