import type { LumiEmotionTag, LumiEmotionTurnInput, LumiRelationshipAssessment, LumiRelationshipGateResult, LumiStateSnapshot } from '../../../lumi-runtime/src'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import {
  checkLumiRelationshipGate,
  createDefaultLumiStateSnapshot,
  migratedLumiContextManifest,
  migratedLumiStateSnapshots,
  normalizeStateSnapshot,
  selectLumiExpression,
  updateLumiStateAfterTurn,
} from '../../../lumi-runtime/src'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const LUMI_EMOTION_STORAGE_KEY = 'lumi/emotion/state:v1'
const LUMI_EMOTION_SEED_STORAGE_KEY = 'lumi/emotion/seed:v1'
const MIGRATION_SEED_ID = `${migratedLumiContextManifest.generatedAt}:${migratedLumiContextManifest.stateCount}`

export const useLumiEmotionStore = defineStore('lumi-emotion', () => {
  const snapshot = useLocalStorageManualReset<LumiStateSnapshot | null>(LUMI_EMOTION_STORAGE_KEY, null)
  const seedId = useLocalStorageManualReset<string>(LUMI_EMOTION_SEED_STORAGE_KEY, '')
  const pendingAssessment = ref<LumiRelationshipAssessment | null>(null)
  const pendingUserText = ref('')
  const pendingRelationshipAssessment = computed<LumiRelationshipAssessment | undefined>(() => pendingAssessment.value ?? undefined)
  const pendingRelationshipGate = computed<LumiRelationshipGateResult | undefined>(() => {
    if (!snapshot.value || !pendingAssessment.value || !pendingUserText.value)
      return undefined
    return checkLumiRelationshipGate(snapshot.value, pendingUserText.value, pendingAssessment.value)
  })
  const currentState = computed(() => snapshot.value)
  const dominantEmotion = computed<LumiEmotionTag>(() => snapshot.value?.dominantEmotion ?? 'neutral')
  const selectedExpression = computed<LumiEmotionTag>(() => selectLumiExpression(
    snapshot.value ?? undefined,
    pendingUserText.value,
    pendingAssessment.value ?? undefined,
    pendingRelationshipGate.value,
  ))

  function initialize() {
    if (snapshot.value) {
      try {
        snapshot.value = normalizeStateSnapshot(snapshot.value)
      }
      catch {
        resetToMigratedSnapshot()
      }
      return
    }
    resetToMigratedSnapshot()
  }

  function resetToMigratedSnapshot() {
    snapshot.value = normalizeStateSnapshot(selectLatestMigratedState() ?? createDefaultLumiStateSnapshot({
      userId: 'local',
      personaId: 'lumi',
    }))
    seedId.value = MIGRATION_SEED_ID
  }

  function updateAfterTurn(input: LumiEmotionTurnInput) {
    initialize()
    const assessment = input.relationshipAssessment
      ?? (pendingUserText.value.trim() === input.userText.trim() ? pendingAssessment.value ?? undefined : undefined)
    snapshot.value = updateLumiStateAfterTurn(snapshot.value ?? undefined, {
      ...input,
      relationshipAssessment: assessment,
      now: input.now ?? new Date().toISOString(),
    })
    clearPendingRelationshipAssessment()
    return snapshot.value
  }

  function previewExpression(userText = '') {
    initialize()
    const assessment = pendingUserText.value.trim() === userText.trim()
      ? pendingAssessment.value ?? undefined
      : undefined
    const gate = snapshot.value
      ? checkLumiRelationshipGate(snapshot.value, userText, assessment)
      : undefined
    return selectLumiExpression(snapshot.value ?? undefined, userText, assessment, gate)
  }

  function previewRelationshipGate(userText = '') {
    initialize()
    if (!snapshot.value)
      return undefined
    const assessment = pendingUserText.value.trim() === userText.trim()
      ? pendingAssessment.value ?? undefined
      : undefined
    return checkLumiRelationshipGate(snapshot.value, userText, assessment)
  }

  function setPendingRelationshipAssessment(userText: string, assessment: LumiRelationshipAssessment) {
    pendingUserText.value = userText
    pendingAssessment.value = assessment
  }

  function clearPendingRelationshipAssessment() {
    pendingUserText.value = ''
    pendingAssessment.value = null
  }

  function setState(state: LumiStateSnapshot) {
    snapshot.value = normalizeStateSnapshot(state)
  }

  function resetState() {
    snapshot.reset()
    seedId.reset()
  }

  return {
    snapshot,
    seedId,
    currentState,
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
