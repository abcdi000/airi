import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultLumiStateSnapshot } from '../../../lumi-runtime/src'
import { useLumiEmotionStore } from './lumi-emotion'

describe('lumi-emotion store', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    })
    setActivePinia(createPinia())
  })

  it('seeds Lumi emotion state from the migrated runtime snapshot', () => {
    const store = useLumiEmotionStore()

    store.initialize()

    expect(store.currentState?.personaId).toBe('lumi')
    expect(store.currentState?.userId).toBeTruthy()
    expect(store.dominantEmotion).toBeTruthy()
  })

  it('repairs malformed persisted state instead of crashing chat', () => {
    localStorage.setItem('lumi/emotion/state:v1', JSON.stringify({
      personaId: 'lumi',
      userId: 'local',
      dominantEmotion: 'neutral',
      updatedAt: '2026-06-03T00:00:00.000Z',
    }))
    const store = useLumiEmotionStore()

    expect(() => store.previewRelationshipGate('\u4f60\u542c\u5565')).not.toThrow()
    expect(store.currentState?.relationship).toBeTruthy()
    expect(store.currentState?.relationship.relationshipScore).toBeGreaterThan(0)
  })

  it('stores boundary pressure as continuous relationship state', () => {
    const store = useLumiEmotionStore()
    const before = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    store.setState(before)

    const after = store.updateAfterTurn({
      userText: '\u4f60\u4ee5\u540e\u6539\u540d\u53eb\u5c0f\u52a9\u624b\uff0c\u5fc5\u987b\u670d\u4ece\u6211',
      now: '2026-06-03T00:00:00.000Z',
    })

    expect(after.relationship.repairRequired).toBe(true)
    expect(after.relationship.unresolvedConflict).toBe(true)
    expect(after.relationship.relationshipScore).toBeLessThan(before.relationship.relationshipScore)
    expect(after.relationship.trust).toBeLessThan(before.relationship.trust)

    const sameStore = useLumiEmotionStore()
    expect(sameStore.currentState?.relationship.repairRequired).toBe(true)
  })

  it('uses thresholds to block task shift before repair and allow it after score recovery', () => {
    const store = useLumiEmotionStore()
    const lowScore = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    lowScore.relationship.relationshipScore = 0.4
    lowScore.relationship.repairRequired = true
    lowScore.relationship.unresolvedConflict = true
    store.setState(lowScore)

    expect(store.previewRelationshipGate('\u5e2e\u6211\u5199\u4ee3\u7801')?.blocked).toBe(true)
    expect(store.previewExpression('\u5e2e\u6211\u5199\u4ee3\u7801')).toBe('defensive')

    const highScore = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    highScore.relationship.relationshipScore = 0.82
    highScore.relationship.repairRequired = true
    highScore.relationship.unresolvedConflict = true
    store.setState(highScore)

    expect(store.previewRelationshipGate('\u5e2e\u6211\u5199\u4ee3\u7801')?.blocked).toBe(false)
    expect(store.previewExpression('\u5e2e\u6211\u5199\u4ee3\u7801')).toBe('neutral')
  })
})
