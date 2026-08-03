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
  /** @example An unavailable ANN worker leaves lexical retrieval available. */
  it('returns no semantic candidates when the ANN worker is unavailable', async () => {
    class UnavailableAnnWorker extends LumiVectorWorker {
      override async openAnnIndex(): Promise<never> {
        throw new Error('test ANN worker unavailable')
      }
    }

    const database = LumiServerDatabase.open(':memory:')
    const worker = new UnavailableAnnWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      const memory = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Semantic retrieval should degrade safely.'),
      })
      database.setMemoryStatus(memory.id, 'active')
      database.upsertMemoryVector(vectorRecord(memory, [1, 0]))

      await expect(vectors.search(request(DOGGY_PERSON_ID))).resolves.toEqual([])
      expect(vectors.status().annReason).toContain('test ANN worker unavailable')
    }
    finally {
      await vectors.stop()
      database.close()
    }
  })

  /** @example Repeated server recall avoids a second query-model invocation. */
  it('reuses a bounded query embedding across repeated searches', async () => {
    class CountingVectorWorker extends LumiVectorWorker {
      calls = 0

      override async embed(texts: string[]): Promise<number[][]> {
        this.calls += 1
        return texts.map(text => text.includes('birthday') ? [1, 0] : [0, 1])
      }
    }

    const database = LumiServerDatabase.open(':memory:')
    const worker = new CountingVectorWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      const birthday = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Lumi birthday fact', 'persona_fact'),
      })
      database.setMemoryStatus(birthday.id, 'active')

      await vectors.backfill()
      await vectors.search(request(DOGGY_PERSON_ID))
      await vectors.search(request(DOGGY_PERSON_ID))

      expect(worker.calls).toBe(2)
    }
    finally {
      await vectors.stop()
      database.close()
    }
  })

  it('backfills through one Node-owned worker and keeps private memories isolated', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const worker = new LumiVectorWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
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

  /** @example A semantically unique memory remains searchable beyond the old row-800 window. */
  it('finds an older relevant memory beyond 800 unrelated vectors', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const worker = new LumiVectorWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      const birthday = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Lumi birthday is represented by the unique birthday vector.', 'persona_fact'),
      })
      database.setMemoryStatus(birthday.id, 'active')
      for (let index = 0; index < 820; index += 1) {
        const memory = database.storeMemoryCandidate({
          actorPersonId: DOGGY_PERSON_ID,
          conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
          candidate: candidate(`Unrelated neutral memory ${index}.`),
        })
        database.setMemoryStatus(memory.id, 'active')
      }

      await vectors.backfill()
      const result = await vectors.search(request(DOGGY_PERSON_ID))

      expect(result[0]?.id).toBe(birthday.id)
      expect(vectors.status().annCount).toBe(821)
    }
    finally {
      await vectors.stop()
      database.close()
    }
  }, 30_000)

  /** @example Another person's private high-score rows cannot crowd out an authorized result. */
  it('revalidates ANN candidates through SQLite ACL after 520 private collisions', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const worker = new LumiVectorWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      for (let index = 0; index < 520; index += 1) {
        const memory = database.storeMemoryCandidate({
          actorPersonId: MOUSSY_PERSON_ID,
          conversationId: `lumi-direct:${MOUSSY_PERSON_ID}`,
          candidate: candidate(`Moussy private birthday collision ${index}.`),
        })
        database.setMemoryStatus(memory.id, 'active')
      }
      const doggy = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Doggy authorized birthday result.'),
      })
      database.setMemoryStatus(doggy.id, 'active')

      await vectors.backfill()
      const result = await vectors.search(request(DOGGY_PERSON_ID))

      expect(result.map(memory => memory.id)).toContain(doggy.id)
      expect(result.every(memory => memory.userId !== MOUSSY_PERSON_ID)).toBe(true)
    }
    finally {
      await vectors.stop()
      database.close()
    }
  }, 30_000)

  /** @example SQLite vector updates and deletes incrementally change persistent ANN results. */
  it('applies vector updates and deletion changes before the next search', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const worker = new LumiVectorWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      const first = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('First mutable memory.'),
      })
      const second = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Second mutable memory.'),
      })
      database.setMemoryStatus(first.id, 'active')
      database.setMemoryStatus(second.id, 'active')
      await vectors.backfill()

      database.upsertMemoryVector(vectorRecord(first, [1, 0]))
      database.upsertMemoryVector(vectorRecord(second, [0, 1]))
      expect((await vectors.search(request(DOGGY_PERSON_ID)))[0]?.id).toBe(first.id)

      database.upsertMemoryVector(vectorRecord(first, [0, 1]))
      database.upsertMemoryVector(vectorRecord(second, [1, 0]))
      expect((await vectors.search(request(DOGGY_PERSON_ID)))[0]?.id).toBe(second.id)

      expect(database.deleteMemoryVector(second.id)).toBe(true)
      expect((await vectors.search(request(DOGGY_PERSON_ID))).map(memory => memory.id)).not.toContain(second.id)
      expect(vectors.status().annCount).toBe(1)
    }
    finally {
      await vectors.stop()
      database.close()
    }
  })

  /** @example A vector committed as an ANN rebuild finishes is applied incrementally. */
  it('refreshes the authoritative ANN head after a concurrent rebuild write', async () => {
    const database = LumiServerDatabase.open(':memory:')
    let concurrentMemoryId = ''
    class ConcurrentWriteWorker extends LumiVectorWorker {
      rebuilds = 0

      override async rebuildAnnIndex(
        head: Parameters<LumiVectorWorker['rebuildAnnIndex']>[0],
        readPage: Parameters<LumiVectorWorker['rebuildAnnIndex']>[1],
      ) {
        this.rebuilds += 1
        const status = await super.rebuildAnnIndex(head, readPage)
        if (this.rebuilds === 1) {
          const concurrent = database.storeMemoryCandidate({
            actorPersonId: DOGGY_PERSON_ID,
            conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
            candidate: candidate('Vector committed immediately after the rebuild.'),
          })
          database.setMemoryStatus(concurrent.id, 'active')
          database.upsertMemoryVector(vectorRecord(concurrent, [0, 1]))
          concurrentMemoryId = concurrent.id
        }
        return status
      }
    }

    const worker = new ConcurrentWriteWorker({
      pythonCommand: process.execPath,
      workerScriptPath: fileURLToPath(new URL('./fixtures/vector-worker.mjs', import.meta.url)),
      modelCacheRoot: fileURLToPath(new URL('../.test-vector-cache', import.meta.url)),
      annIndexRoot: fileURLToPath(new URL('../.test-ann-cache', import.meta.url)),
    })
    const vectors = new LumiServerVectorService(database, worker)
    try {
      const initial = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: candidate('Initial vector before the rebuild.'),
      })
      database.setMemoryStatus(initial.id, 'active')

      const status = await vectors.backfill()

      expect(worker.rebuilds).toBe(1)
      expect(status.annCount).toBe(2)
      expect(database.memoryAnnHead(status.model).count).toBe(2)
      expect(database.memoryVectors([concurrentMemoryId], status.model)).toHaveLength(1)
    }
    finally {
      await vectors.stop()
      database.close()
    }
  })
})

function vectorRecord(memory: ReturnType<LumiServerDatabase['storeMemoryCandidate']>, vector: number[]) {
  return {
    memoryId: memory.id,
    model: 'BAAI/bge-small-zh-v1.5',
    dimensions: vector.length,
    vector,
    contentDigest: memoryVectorDigest(memory),
    device: 'test-local',
    updatedAt: Date.now(),
  }
}
