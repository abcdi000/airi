import type { LumiEmotionTag, LumiEmotionTurnInput, LumiRelationshipAssessment, LumiRelationshipGateResult, LumiStateSnapshot } from '../../../lumi-runtime/src'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

import {
  checkLumiRelationshipGate,
  createDefaultLumiStateSnapshot,
  migratedLumiContextManifest,
  migratedLumiStateSnapshots,
  normalizeStateSnapshot,
  selectLumiExpression,
  updateLumiStateAfterTurn,
} from '../../../lumi-runtime/src'
import { LUMI_DOGGY_USER_ID, useLumiIdentityStore } from './lumi-identity'

const LUMI_EMOTION_STORAGE_KEY = 'lumi/emotion/state:v1'
const LUMI_EMOTION_SEED_STORAGE_KEY = 'lumi/emotion/seed:v1'
const LUMI_EMOTION_RELATIONSHIPS_STORAGE_KEY = 'lumi/emotion/relationships:v2'
const LUMI_EMOTION_SELF_STORAGE_KEY = 'lumi/emotion/self:v2'
const MIGRATION_SEED_ID = `${migratedLumiContextManifest.generatedAt}:${migratedLumiContextManifest.stateCount}`

export const useLumiEmotionStore = defineStore('lumi-emotion', () => {
  const { activeUserId } = storeToRefs(useLumiIdentityStore())
  const legacySnapshot = useLocalStorageManualReset<LumiStateSnapshot | null>(LUMI_EMOTION_STORAGE_KEY, null)
  const relationshipSnapshots = useLocalStorageManualReset<Record<string, LumiStateSnapshot>>(LUMI_EMOTION_RELATIONSHIPS_STORAGE_KEY, {})
  const selfState = useLocalStorageManualReset<Pick<LumiStateSnapshot, 'mood' | 'dominantEmotion' | 'updatedAt'> | null>(LUMI_EMOTION_SELF_STORAGE_KEY, null)
  const seedId = useLocalStorageManualReset<string>(LUMI_EMOTION_SEED_STORAGE_KEY, '')
  const pendingAssessments = ref<Record<string, { userText: string, assessment: LumiRelationshipAssessment }>>({})
  const currentUserId = () => activeUserId.value || LUMI_DOGGY_USER_ID
  const resolveUserId = (userId?: string) => userId || currentUserId()

  function getStateForUser(userId: string) {
    const relationship = relationshipSnapshots.value[userId]
    if (!relationship)
      return null
    return normalizeStateSnapshot({
      ...relationship,
      userId,
      mood: selfState.value?.mood ?? relationship.mood,
      dominantEmotion: selfState.value?.dominantEmotion ?? relationship.dominantEmotion,
      updatedAt: [selfState.value?.updatedAt, relationship.updatedAt].filter(Boolean).sort().at(-1) ?? relationship.updatedAt,
    })
  }

  function setStateForUser(userId: string, value: LumiStateSnapshot | null) {
    if (!value) {
      const next = { ...relationshipSnapshots.value }
      delete next[userId]
      relationshipSnapshots.value = next
      return
    }
    const normalized = normalizeStateSnapshot({ ...value, userId })
    relationshipSnapshots.value = { ...relationshipSnapshots.value, [userId]: normalized }
    selfState.value = {
      mood: normalized.mood,
      dominantEmotion: normalized.dominantEmotion,
      updatedAt: normalized.updatedAt,
    }
  }

  const pendingRelationshipAssessment = computed<LumiRelationshipAssessment | undefined>(() =>
    pendingAssessments.value[currentUserId()]?.assessment,
  )
  const snapshot = computed<LumiStateSnapshot | null>({
    get: () => getStateForUser(currentUserId()),
    set: value => setStateForUser(currentUserId(), value),
  })
  const pendingRelationshipGate = computed<LumiRelationshipGateResult | undefined>(() => {
    const pending = pendingAssessments.value[currentUserId()]
    if (!snapshot.value || !pending)
      return undefined
    return checkLumiRelationshipGate(snapshot.value, pending.userText, pending.assessment)
  })
  const currentState = computed(() => snapshot.value)
  const dominantEmotion = computed<LumiEmotionTag>(() => snapshot.value?.dominantEmotion ?? 'neutral')
  const selectedExpression = computed<LumiEmotionTag>(() => selectLumiExpression(
    snapshot.value ?? undefined,
    pendingAssessments.value[currentUserId()]?.userText ?? '',
    pendingAssessments.value[currentUserId()]?.assessment,
    pendingRelationshipGate.value,
  ))

  function initialize(userId?: string) {
    const targetUserId = resolveUserId(userId)
    const state = getStateForUser(targetUserId)
    if (state) {
      try {
        setStateForUser(targetUserId, normalizeStateSnapshot(state))
      }
      catch {
        resetToMigratedSnapshot(targetUserId)
      }
      return
    }
    resetToMigratedSnapshot(targetUserId)
  }

  function resetToMigratedSnapshot(userId?: string) {
    const targetUserId = resolveUserId(userId)
    const existingSelfState = selfState.value
    const migrated = targetUserId === LUMI_DOGGY_USER_ID
      ? legacySnapshot.value ?? selectLatestMigratedState()
      : undefined
    setStateForUser(targetUserId, normalizeStateSnapshot(migrated ?? createDefaultLumiStateSnapshot({
      userId: targetUserId,
      personaId: 'lumi',
    })))
    if (existingSelfState)
      selfState.value = existingSelfState
    seedId.value = MIGRATION_SEED_ID
  }

  function updateAfterTurn(input: LumiEmotionTurnInput, userId?: string) {
    const targetUserId = resolveUserId(userId)
    initialize(targetUserId)
    const pending = pendingAssessments.value[targetUserId]
    const assessment = input.relationshipAssessment
      ?? (pending?.userText.trim() === input.userText.trim() ? pending.assessment : undefined)
    setStateForUser(targetUserId, updateLumiStateAfterTurn(getStateForUser(targetUserId) ?? undefined, {
      ...input,
      relationshipAssessment: assessment,
      now: input.now ?? new Date().toISOString(),
    }))
    clearPendingRelationshipAssessment(targetUserId)
    return getStateForUser(targetUserId)!
  }

  function previewExpression(userText = '', userId?: string) {
    const targetUserId = resolveUserId(userId)
    initialize(targetUserId)
    const state = getStateForUser(targetUserId)
    const pending = pendingAssessments.value[targetUserId]
    const assessment = pending?.userText.trim() === userText.trim()
      ? pending.assessment
      : undefined
    const gate = state
      ? checkLumiRelationshipGate(state, userText, assessment)
      : undefined
    return selectLumiExpression(state ?? undefined, userText, assessment, gate)
  }

  function previewRelationshipGate(userText = '', userId?: string) {
    const targetUserId = resolveUserId(userId)
    initialize(targetUserId)
    const state = getStateForUser(targetUserId)
    if (!state)
      return undefined
    const pending = pendingAssessments.value[targetUserId]
    const assessment = pending?.userText.trim() === userText.trim()
      ? pending.assessment
      : undefined
    return checkLumiRelationshipGate(state, userText, assessment)
  }

  function setPendingRelationshipAssessment(userText: string, assessment: LumiRelationshipAssessment, userId?: string) {
    const targetUserId = resolveUserId(userId)
    pendingAssessments.value = {
      ...pendingAssessments.value,
      [targetUserId]: { userText, assessment },
    }
  }

  function clearPendingRelationshipAssessment(userId?: string) {
    const targetUserId = resolveUserId(userId)
    const next = { ...pendingAssessments.value }
    delete next[targetUserId]
    pendingAssessments.value = next
  }

  function setState(state: LumiStateSnapshot, userId?: string) {
    const targetUserId = resolveUserId(userId)
    setStateForUser(targetUserId, normalizeStateSnapshot({ ...state, userId: targetUserId }))
  }

  function exportSnapshot() {
    return {
      snapshot: snapshot.value,
      seedId: seedId.value,
      exportedAt: new Date().toISOString(),
    }
  }

  function importSnapshot(input: { snapshot?: LumiStateSnapshot | null, seedId?: string }) {
    const targetUserId = currentUserId()
    setStateForUser(targetUserId, input.snapshot ? normalizeStateSnapshot(input.snapshot) : null)
    seedId.value = typeof input.seedId === 'string' ? input.seedId : ''
  }

  function resetState() {
    const targetUserId = currentUserId()
    setStateForUser(targetUserId, null)
    clearPendingRelationshipAssessment(targetUserId)
    if (targetUserId === LUMI_DOGGY_USER_ID) {
      legacySnapshot.reset()
      seedId.reset()
    }
  }

  return {
    snapshot,
    seedId,
    currentState,
    getStateForUser,
    dominantEmotion,
    selectedExpression,
    initialize,
    resetToMigratedSnapshot,
    updateAfterTurn,
    previewExpression,
    previewRelationshipGate,
    setPendingRelationshipAssessment,
    clearPendingRelationshipAssessment,
    setState,
    exportSnapshot,
    importSnapshot,
    resetState,
    pendingRelationshipAssessment,
    pendingRelationshipGate,
  }
})

function selectLatestMigratedState() {
  return [...migratedLumiStateSnapshots].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0]
}
