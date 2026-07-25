import type { LumiStickerIntelligence } from '@proj-airi/lumi-server-runtime'

import type { ElectronLumiStickerLibraryConfig } from '../../../../shared/eventa'

import { Buffer } from 'node:buffer'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { LumiStickerLibrary } from './sticker-library'

const roots: string[] = []
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

function config(overrides: Partial<ElectronLumiStickerLibraryConfig> = {}): ElectronLumiStickerLibraryConfig {
  return {
    enabled: true,
    collectFromStudyGroups: true,
    relativePath: 'data/lumi-stickers',
    maximumItems: 2,
    sendProbability: 1,
    cooldownMessages: 2,
    ...overrides,
  }
}

async function createLibrary(
  overrides: Partial<ElectronLumiStickerLibraryConfig> = {},
  intelligence?: LumiStickerIntelligence,
) {
  const root = join(tmpdir(), `lumi-sticker-library-${crypto.randomUUID()}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  const current = config(overrides)
  return {
    current,
    library: new LumiStickerLibrary(() => current, () => root, intelligence),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/**
 * @example
 * An observed image is deduplicated, selected once, then held back by cooldown.
 */
describe('lumi sticker library', () => {
  it('deduplicates learned images and enforces the reply cooldown', async () => {
    const { library } = await createLibrary({}, {
      classify: async () => ({
        tags: ['觉得好笑'],
        summary: '群友用这张图表达觉得好笑',
        confidence: 0.92,
      }),
      select: async input => ({
        stickerId: input.candidates[0]?.id,
        reason: '适合当前回复',
      }),
    })
    const input = {
      dataBase64: png.toString('base64'),
      mimeType: 'image/png',
      sourceId: 'qq-group:1',
      senderName: 'Doggy',
      contextText: '笑死了',
      timestamp: 100,
    }

    await library.collect(input)
    await library.collect({ ...input, timestamp: 200 })

    const learned = await library.snapshot()
    expect(learned.stats.total).toBe(1)
    expect(learned.stats.owned).toBe(1)
    expect(learned.stats.received).toBe(2)
    expect(learned.recentEvents.some(event => event.kind === 'duplicate')).toBe(true)

    const first = await library.selectForReply({
      eventId: 'reply-1',
      inputText: '笑死',
      replyText: '确实',
    })
    const second = await library.selectForReply({
      eventId: 'reply-2',
      inputText: '笑死',
      replyText: '确实',
    })

    expect(first?.mimeType).toBe('image/png')
    expect(first?.dataBase64).toBe(png.toString('base64'))
    expect(second).toBeNull()
  })

  it('rejects library paths that escape the configured root', async () => {
    const { library } = await createLibrary({ relativePath: '../outside' })

    await expect(library.snapshot()).rejects.toThrow('safe relative path')
  })

  it('discards the least useful image when capacity is reached', async () => {
    const { library } = await createLibrary({ maximumItems: 1 })

    await library.collect({
      dataBase64: png.toString('base64'),
      mimeType: 'image/png',
      sourceId: 'source-a',
      senderName: 'A',
      contextText: '第一张',
      timestamp: 100,
    })
    await library.collect({
      dataBase64: Buffer.concat([png, Buffer.from([1])]).toString('base64'),
      mimeType: 'image/png',
      sourceId: 'source-b',
      senderName: 'B',
      contextText: '第二张',
      timestamp: 200,
    })

    const snapshot = await library.snapshot()
    expect(snapshot.stats.total).toBe(2)
    expect(snapshot.stats.owned).toBe(1)
    expect(snapshot.stats.discarded).toBe(1)
    expect(snapshot.recentEvents.some(event => event.kind === 'discarded')).toBe(true)
  })

  it('stores only consciousness-model tags and never infers tags from keywords', async () => {
    const contexts: string[] = []
    const { library } = await createLibrary({ maximumItems: 3 }, {
      classify: async (input) => {
        contexts.push(input.contextText)
        return input.contextText.includes('模型明确判断')
          ? {
              tags: ['调侃'],
              summary: '模型结合对话判断为调侃',
              confidence: 0.9,
            }
          : {
              tags: [],
              summary: '证据不足',
              confidence: 0,
            }
      },
      select: async () => ({ reason: '当前不需要发表情' }),
    })

    await library.collect({
      dataBase64: png.toString('base64'),
      mimeType: 'image/png',
      sourceId: 'source-a',
      senderName: 'A',
      contextText: '气死了，但模型没有足够上下文',
      timestamp: 101,
    })
    await library.collect({
      dataBase64: Buffer.concat([png, Buffer.from([2])]).toString('base64'),
      mimeType: 'image/png',
      sourceId: 'source-a',
      senderName: 'A',
      contextText: '模型明确判断这是朋友间的调侃',
      timestamp: 1_001,
    })

    const snapshot = await library.snapshot()
    const collected = snapshot.recentEvents.filter(event => event.kind === 'collected')
    expect(contexts).toEqual([
      '气死了，但模型没有足够上下文',
      '模型明确判断这是朋友间的调侃',
    ])
    expect(collected).toHaveLength(2)
    expect(collected.some(event => event.detail.includes('生气'))).toBe(false)
    expect(collected.some(event => event.detail.includes('调侃'))).toBe(true)
    expect(collected.some(event => event.detail.includes('等待意识模型获得足够语境'))).toBe(true)
  })

  it('keeps a sticker pending when consciousness classification is unavailable', async () => {
    const { library } = await createLibrary({ maximumItems: 1 }, {
      classify: async () => {
        throw new Error('model unavailable')
      },
      select: async () => ({ reason: 'not used' }),
    })

    await library.collect({
      dataBase64: png.toString('base64'),
      mimeType: 'image/png',
      sourceId: 'source-a',
      senderName: 'A',
      contextText: '这句话包含生气、开心和难过等各种关键词',
      timestamp: 100,
    })

    const snapshot = await library.snapshot()
    expect(snapshot.recentEvents.some(event => event.kind === 'warning')).toBe(true)
    expect(snapshot.recentEvents.some(event => event.detail.includes('等待意识模型获得足够语境'))).toBe(true)
    expect(snapshot.recentEvents.some(event => event.detail.includes('生气'))).toBe(false)
  })

  it('persists manual tags and supports preview, discard, restore, and permanent deletion', async () => {
    const { library } = await createLibrary({}, {
      classify: async () => ({
        tags: ['model-tag'],
        summary: 'model classification',
        confidence: 0.9,
      }),
      select: async () => ({ reason: 'not used' }),
    })
    const input = {
      dataBase64: png.toString('base64'),
      mimeType: 'image/png',
      sourceId: 'source-a',
      senderName: 'A',
      contextText: 'context',
      timestamp: 100,
    }

    await library.collect(input)
    const first = await library.snapshot()
    const stickerId = first.records[0]!.id
    const preview = await library.readPreview(stickerId)

    expect(preview?.dataBase64).toBe(png.toString('base64'))
    expect(preview?.mimeType).toBe('image/png')

    await library.updateRecord(stickerId, { tags: ['manual-tag'], status: 'discarded' })
    await library.collect({ ...input, timestamp: 200 })
    const edited = await library.snapshot()

    expect(edited.records[0]?.tags).toEqual(['manual-tag'])
    expect(edited.records[0]?.tagsManuallyEdited).toBe(true)
    expect(edited.records[0]?.status).toBe('discarded')

    await library.updateRecord(stickerId, { status: 'owned' })
    expect((await library.snapshot()).records[0]?.status).toBe('owned')

    await library.deleteRecord(stickerId)
    expect((await library.snapshot()).records).toEqual([])
    await expect(library.readPreview(stickerId)).resolves.toBeNull()
  })
})
