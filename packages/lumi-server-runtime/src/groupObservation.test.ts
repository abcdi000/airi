import type { GroupObservationEnvelope } from '@proj-airi/lumi-agent-runtime'

import type { LumiServerGroupObservationOptions } from './groupObservation'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_LANGUAGE_LEARNING_CONFIG } from '@proj-airi/lumi-runtime'
import { describe, expect, it, vi } from 'vitest'

import { LumiServerDatabase } from './database'
import { createLumiServerGroupObservationRuntime } from './groupObservation'

const studyGroups = [{
  sourceId: 'friends',
  platformInstanceId: 'qq-bot-1',
  groupId: '20001',
  enabled: true,
}] as const

/**
 * @example
 * `observation(1, '不是哥们')` creates a verified, reply-free group envelope.
 */
function observation(index: number, text: string): GroupObservationEnvelope {
  return {
    eventId: `event-${index}`,
    messageId: `message-${index}`,
    sourceId: 'friends',
    platform: 'aiocqhttp',
    platformInstanceId: 'qq-bot-1',
    groupId: '20001',
    senderId: `sender-${index % 2}`,
    senderName: `Friend ${index % 2}`,
    authorVerified: true,
    isLumi: false,
    sourceKind: 'human_message',
    text,
    images: [],
    segments: [{ type: 'text', text }],
    timestamp: 1_700_000_000_000 + index,
    conversationType: 'group_observation',
  }
}

function curatorResponse(
  purpose: Parameters<LumiServerGroupObservationOptions['model']['generateLanguageText']>[1],
) {
  if (purpose === 'expression_learning') {
    return JSON.stringify({
      candidates: [{
        sourceMessageIds: ['message-1', 'message-2'],
        phrase: '不是哥们',
        situation: '朋友间对意外情况作出反应',
        pragmaticFunction: '用短句表达意外',
        patternType: 'reaction',
        confidence: 0.9,
      }],
    })
  }
  if (purpose === 'public_knowledge_learning') {
    return JSON.stringify({
      candidates: [{
        sourceMessageIds: ['message-1', 'message-2'],
        content: '这个群通常在晚上讨论游戏',
        confidence: 0.85,
      }],
    })
  }
  return JSON.stringify({ candidates: [] })
}

describe('createLumiServerGroupObservationRuntime', () => {
  /**
   * @example
   * Two observations form one persisted batch and one learned candidate.
   */
  it('persists, curates, and completes one source-local batch', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const generateLanguageText = vi.fn(async (
      _messages: Parameters<LumiServerGroupObservationOptions['model']['generateLanguageText']>[0],
      _purpose: Parameters<LumiServerGroupObservationOptions['model']['generateLanguageText']>[1],
    ) => curatorResponse(_purpose))
    try {
      const runtime = createLumiServerGroupObservationRuntime({
        database,
        model: { generateLanguageText },
        enabled: true,
        batchSize: 2,
        studyGroups,
        languageLearning: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      })

      await runtime.observe(observation(1, '不是哥们'))
      await runtime.observe(observation(2, '不是哥们，这也能炸'))
      await runtime.drain()

      const snapshot = database.getSocialLanguageSnapshot()
      expect(generateLanguageText).toHaveBeenCalledTimes(4)
      expect(new Set(generateLanguageText.mock.calls.map(call => call[1]))).toEqual(new Set([
        'expression_learning',
        'jargon_learning',
        'behavior_learning',
        'public_knowledge_learning',
      ]))
      expect(snapshot.observationBuffer).toEqual([])
      expect(snapshot.observationHistory.map(item => item.messageId)).toEqual([
        'message-1',
        'message-2',
      ])
      expect(snapshot.observationBatches).toHaveLength(1)
      expect(snapshot.observationBatches[0]?.sourceId).toBe('friends')
      expect(snapshot.expressions).toHaveLength(1)
      expect(snapshot.expressions[0]?.phrase).toBe('不是哥们')
      expect(snapshot.publicKnowledge).toHaveLength(1)
      expect(snapshot.observationBatches[0]?.curators?.expression?.status).toBe('completed')
      expect(snapshot.observationBatches[0]?.curators?.public_knowledge?.status).toBe('completed')
    }
    finally {
      database.close()
    }
  })

  /**
   * @example
   * Invalid curator output keeps source evidence pending for an operator retry.
   */
  it('does not consume a batch when model output violates the curator protocol', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const generateLanguageText = vi.fn(async () => '没有值得学习的内容')
    try {
      const runtime = createLumiServerGroupObservationRuntime({
        database,
        model: { generateLanguageText },
        enabled: true,
        batchSize: 2,
        studyGroups,
        languageLearning: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      })

      await runtime.observe(observation(1, '第一条'))
      await runtime.observe(observation(2, '第二条'))
      await runtime.drain()

      const snapshot = database.getSocialLanguageSnapshot()
      expect(generateLanguageText).toHaveBeenCalledTimes(4)
      expect(snapshot.observationBuffer.map(item => item.messageId)).toEqual([
        'message-1',
        'message-2',
      ])
      expect(snapshot.observationBatches).toHaveLength(1)
      expect(snapshot.observationBatches[0]?.curator).toBe('pending')
      expect(snapshot.observationBatches[0]?.curators?.expression?.status).toBe('failed')
      expect(snapshot.expressions).toEqual([])
    }
    finally {
      database.close()
    }
  })

  it('retries only the failed curator while preserving completed curator writes', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const firstGenerate = vi.fn(async (_messages, purpose) =>
      purpose === 'behavior_learning' ? 'invalid behavior output' : curatorResponse(purpose))
    try {
      const firstRuntime = createLumiServerGroupObservationRuntime({
        database,
        model: { generateLanguageText: firstGenerate },
        enabled: true,
        batchSize: 2,
        studyGroups,
        languageLearning: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      })
      await firstRuntime.observe(observation(1, '不是哥们'))
      await firstRuntime.observe(observation(2, '不是哥们，这也能行'))
      await firstRuntime.drain()

      const partial = database.getSocialLanguageSnapshot()
      expect(firstGenerate).toHaveBeenCalledTimes(4)
      expect(partial.expressions).toHaveLength(1)
      expect(partial.publicKnowledge).toHaveLength(1)
      expect(partial.observationBatches[0]?.curators?.behavior?.status).toBe('failed')
      expect(partial.observationBatches[0]?.curators?.expression?.status).toBe('completed')

      const retryGenerate = vi.fn(async (_messages, purpose) => curatorResponse(purpose))
      const retryRuntime = createLumiServerGroupObservationRuntime({
        database,
        model: { generateLanguageText: retryGenerate },
        enabled: true,
        batchSize: 2,
        studyGroups,
        languageLearning: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      })
      await retryRuntime.resume()
      await retryRuntime.drain()

      const completed = database.getSocialLanguageSnapshot()
      expect(retryGenerate).toHaveBeenCalledTimes(1)
      expect(retryGenerate.mock.calls[0]?.[1]).toBe('behavior_learning')
      expect(completed.observationBuffer).toEqual([])
      expect(completed.expressions).toHaveLength(1)
      expect(completed.publicKnowledge).toHaveLength(1)
      expect(completed.observationBatches[0]?.curators?.behavior?.attempts).toBe(2)
    }
    finally {
      database.close()
    }
  })

  /**
   * @example
   * Pending evidence written before shutdown is restored and curated on restart.
   */
  it('restores persisted pending evidence after a server restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-group-observation-'))
    const databasePath = join(directory, 'server.sqlite3')
    try {
      const firstDatabase = LumiServerDatabase.open(databasePath)
      const firstRuntime = createLumiServerGroupObservationRuntime({
        database: firstDatabase,
        model: { generateLanguageText: async (_messages, purpose) => curatorResponse(purpose) },
        enabled: true,
        batchSize: 3,
        studyGroups,
        languageLearning: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      })
      await firstRuntime.observe(observation(1, '不是哥们'))
      await firstRuntime.observe(observation(2, '不是哥们，这也行'))
      await firstRuntime.drain()
      expect(firstDatabase.getSocialLanguageSnapshot().observationBuffer).toHaveLength(2)
      firstDatabase.close()

      const secondDatabase = LumiServerDatabase.open(databasePath)
      try {
        const generateLanguageText = vi.fn(async (_messages, purpose) => curatorResponse(purpose))
        const secondRuntime = createLumiServerGroupObservationRuntime({
          database: secondDatabase,
          model: { generateLanguageText },
          enabled: true,
          batchSize: 2,
          studyGroups,
          languageLearning: DEFAULT_LANGUAGE_LEARNING_CONFIG,
        })

        await secondRuntime.resume()
        await secondRuntime.drain()

        const snapshot = secondDatabase.getSocialLanguageSnapshot()
        expect(generateLanguageText).toHaveBeenCalledTimes(4)
        expect(snapshot.observationBuffer).toEqual([])
        expect(snapshot.observationBatches[0]?.messageIds).toEqual([
          'message-1',
          'message-2',
        ])
      }
      finally {
        secondDatabase.close()
      }
    }
    finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
