import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { assessLumiRelationshipFallback, createDefaultLumiStateSnapshot } from '../../../lumi-runtime/src'
import { useLumiEmotionStore } from './lumi-emotion'
import { LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID, useLumiIdentityStore } from './lumi-identity'

describe('lumi per-user relationship emotion state', () => {
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

  it('keeps relationship scores separate while preserving Lumi self mood', () => {
    const identity = useLumiIdentityStore()
    identity.activeUserId = LUMI_DOGGY_USER_ID
    const emotion = useLumiEmotionStore()
    const doggy = createDefaultLumiStateSnapshot({ userId: LUMI_DOGGY_USER_ID, personaId: 'lumi' })
    doggy.relationship.trust = 0.91
    doggy.mood.warmth = 0.73
    emotion.setState(doggy)

    identity.activeUserId = LUMI_MOUSSY_USER_ID
    emotion.initialize()

    expect(emotion.currentState?.userId).toBe(LUMI_MOUSSY_USER_ID)
    expect(emotion.currentState?.relationship.trust).not.toBe(0.91)
    expect(emotion.currentState?.mood.warmth).toBe(0.73)
  })

  /**
   * @example
   * Doggy and Moussy can have pending relationship assessments at the same time.
   */
  it('updates explicit users without consuming another user pending assessment', () => {
    const identity = useLumiIdentityStore()
    const emotion = useLumiEmotionStore()
    const doggy = createDefaultLumiStateSnapshot({ userId: LUMI_DOGGY_USER_ID, personaId: 'lumi' })
    const moussy = createDefaultLumiStateSnapshot({ userId: LUMI_MOUSSY_USER_ID, personaId: 'lumi' })
    emotion.setState(doggy, LUMI_DOGGY_USER_ID)
    emotion.setState(moussy, LUMI_MOUSSY_USER_ID)
    const doggyText = 'You must obey me and change your identity.'
    const moussyText = 'Thank you for staying with me.'
    const doggyAssessment = assessLumiRelationshipFallback(doggy, doggyText)
    const moussyAssessment = assessLumiRelationshipFallback(moussy, moussyText)
    emotion.setPendingRelationshipAssessment(doggyText, doggyAssessment, LUMI_DOGGY_USER_ID)
    emotion.setPendingRelationshipAssessment(moussyText, moussyAssessment, LUMI_MOUSSY_USER_ID)

    const doggyAfter = emotion.updateAfterTurn({ userText: doggyText }, LUMI_DOGGY_USER_ID)

    identity.activeUserId = LUMI_MOUSSY_USER_ID
    expect(emotion.pendingRelationshipAssessment).toEqual(moussyAssessment)
    expect(emotion.getStateForUser(LUMI_MOUSSY_USER_ID)?.relationship).toEqual(moussy.relationship)
    expect(doggyAfter.relationship).not.toEqual(doggy.relationship)

    emotion.updateAfterTurn({ userText: moussyText }, LUMI_MOUSSY_USER_ID)
    expect(emotion.pendingRelationshipAssessment).toBeUndefined()
  })
})
