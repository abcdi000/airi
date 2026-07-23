import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DOGGY_PERSON_ID,
  LumiServerDatabase,
  MOUSSY_PERSON_ID,
} from './database'
import {
  LumiServerVectorService,
  LumiVectorWorker,
  memoryVectorDigest,
} from './vectorService'

function candidate(content: string, type: 'persona_fact' | 'user_fact' = 'user_fact') {
  return {
    type,
    content,
    confidence: 1,
    importance: 1,
    emotionalIntensity: 0.2,
    relationshipRelevance: 0.8,
    decay: 0.1,
    tags: type === 'persona_fact' ? ['lumi_self'] : [],
    status: 'candidate' as const,
    reason: 'vector regression test',
    ...(type === 'persona_fact' ? { scope: 'global' as const } : {}),
  }
}

function request(personId: string) {
  return {
    query: 'birthday',
    userId: personId,
    viewerUserId: personId,
    personaId: 'lumi',
    conversationType: 'direct' as const,
    conversationId: `lumi-direct:${personId}`,
    limit: 20,
  }
}

describe('lumiServerVectorService', () => {
  it('backfills through one Node-owned worker and keeps private memories isolated', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const worker = new LumiVectorWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      const birthday = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Lumi\'s birthday is July 21.', 'persona_fact'),
      })
      const doggyPrivate = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Doggy has a private Minecraft plan.'),
      })
      database.setMemoryStatus(birthday.id, 'active')
      database.setMemoryStatus(doggyPrivate.id, 'active')

      const status = await vectors.backfill()
      const moussyResults = await vectors.search(request(MOUSSY_PERSON_ID))

      expect(status.indexedCount).toBe(2)
      expect(status.running).toBe(true)
      expect(status.device).toBe('test-local')
      expect(moussyResults.map(memory => memory.id)).toEqual([birthday.id])
      expect(database.memoryVectors([birthday.id], status.model)[0].contentDigest).toBe(memoryVectorDigest(birthday))
    }
    finally {
      await vectors.stop()
      database.close()
    }
  })
})
