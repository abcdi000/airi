import type { MaybeRefOrGetter } from 'vue'

import type {
  ElectronLumiAstrBotGatewayConfig,
  ElectronLumiAstrBotGatewayState,
  ElectronLumiAstrBotStudyGroup,
} from '../../../../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useLumiSocialLanguageStore } from '@proj-airi/stage-ui/stores/lumi-social-language'
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, toValue } from 'vue'

import {
  electronLumiAstrBotGatewayGetState,
  electronLumiAstrBotGatewayResumeLearning,
} from '../../../../../shared/eventa'

export interface AstrBotLearningMonitorEvent {
  id: string
  kind: 'message' | 'batch' | 'sticker' | 'warning'
  sourceId: string
  timestamp: number
  title: string
  detail: string
}

export interface AstrBotLearningMonitorChange {
  id: string
  kind: 'expression' | 'jargon' | 'behavior'
  timestamp: number
  label: string
  detail: string
}

/**
 * Projects Lumi's social-language snapshot into a privacy-bounded monitor.
 *
 * Use when:
 * - Showing AstrBot group observations without entering chat or memory state
 * - Explaining which language candidates changed after each learning batch
 *
 * Expects:
 * - Sources are the currently applied gateway configuration
 *
 * Returns:
 * - Read-only computed monitor rows and counters
 */
export function useAstrBotLearningMonitor(options: {
  mode: MaybeRefOrGetter<ElectronLumiAstrBotGatewayConfig['learningMode']>
  groups: MaybeRefOrGetter<ElectronLumiAstrBotStudyGroup[]>
  batchSize: MaybeRefOrGetter<number>
  concurrentGroups: MaybeRefOrGetter<number>
}) {
  const store = useLumiSocialLanguageStore()
  const chatOrchestrator = useChatOrchestratorStore()
  const getGatewayState = useElectronEventaInvoke(electronLumiAstrBotGatewayGetState)
  const resumeLearning = useElectronEventaInvoke(electronLumiAstrBotGatewayResumeLearning)
  const { activeObservationBatches, snapshot } = storeToRefs(store)
  const gatewayState = shallowRef<ElectronLumiAstrBotGatewayState>()
  const isReprocessing = shallowRef(false)
  const reprocessResult = shallowRef<string>()
  useIntervalFn(() => {
    if (toValue(options.mode) === 'observe_only') {
      void store.refreshFromPersistence()
      void getGatewayState()
        .then(state => gatewayState.value = state)
        .catch(() => undefined)
    }
  }, 750, { immediateCallback: true })

  const sourceNames = computed(() => new Map(
    toValue(options.groups).map(group => [group.id, group.displayName || group.groupId]),
  ))
  const enabledGroups = computed(() => toValue(options.groups).filter(group => group.enabled && group.groupId.trim()))
  const pendingCount = computed(() => snapshot.value.observationBuffer.length)
  const recentObservationCount = computed(() => snapshot.value.observationHistory.length)
  const processedMessageCount = computed(() => new Set(
    snapshot.value.observationBatches.flatMap(batch => batch.messageIds),
  ).size)
  const changedKnowledgeCount = computed(() => snapshot.value.observationBatches.reduce(
    (total, batch) => total + batch.expressionIds.length + batch.jargonIds.length + batch.behaviorIds.length,
    0,
  ))
  const missedMessageCount = computed(() => store.recoverableObservationGroups()
    .reduce((total, group) => total + group.observations.length, 0))

  async function resumePending() {
    await resumeLearning()
  }

  async function reprocessMissed() {
    if (isReprocessing.value || missedMessageCount.value === 0)
      return
    isReprocessing.value = true
    reprocessResult.value = undefined
    try {
      const result = await chatOrchestrator.reprocessMissedExternalGroupLanguage()
      reprocessResult.value = result.recoveredMessageCount > 0
        ? `已重新归纳 ${result.recoveredMessageCount} 条消息，更新 ${result.changedKnowledgeCount} 项知识`
        : '意识模型仍未提取出可用知识，原消息继续保留待重试'
      await store.refreshFromPersistence()
    }
    catch (error) {
      reprocessResult.value = `重新归纳失败：${errorMessageFrom(error) ?? '未知错误'}`
    }
    finally {
      isReprocessing.value = false
    }
  }
  const status = computed(() => {
    if (toValue(options.mode) !== 'observe_only')
      return { tone: 'idle' as const, label: '未启用学习模式', detail: '切换并保存后才会接收指定群聊' }
    if (!enabledGroups.value.length)
      return { tone: 'warning' as const, label: '等待配置学习群', detail: '当前不会接收任何群聊' }
    if (activeObservationBatches.value.length) {
      const processingMessages = activeObservationBatches.value.reduce((total, batch) => total + batch.messageCount, 0)
      return {
        tone: 'processing' as const,
        label: '正在归纳',
        detail: `${activeObservationBatches.value.length} 个群的 ${processingMessages} 条消息正在生成结果，另有 ${pendingCount.value} 条排队`,
      }
    }
    if (pendingCount.value >= Math.max(1, toValue(options.batchSize))) {
      return {
        tone: 'processing' as const,
        label: '后台归纳队列',
        detail: `${pendingCount.value} 条消息排队，最多同时归纳 ${Math.max(1, toValue(options.concurrentGroups))} 个群`,
      }
    }
    return { tone: 'live' as const, label: '正在监听', detail: `${enabledGroups.value.length} 个群已启用，只读且禁止回复` }
  })
  const sourceProgress = computed(() => enabledGroups.value.map((group) => {
    const pending = snapshot.value.observationBuffer.filter(item => item.sourceId === group.id).length
    const recentlyReceived = snapshot.value.observationHistory.filter(item => item.sourceId === group.id).length
    const last = snapshot.value.observationHistory.findLast(item => item.sourceId === group.id)
    return {
      ...group,
      pending,
      recentlyReceived,
      progress: Math.min(100, pending / Math.max(1, toValue(options.batchSize)) * 100),
      lastReceivedAt: last?.timestamp,
    }
  }))
  const recentEvents = computed<AstrBotLearningMonitorEvent[]>(() => {
    const messages = snapshot.value.observationHistory.map(observation => ({
      id: `message:${observation.eventId}`,
      kind: 'message' as const,
      sourceId: observation.sourceId,
      timestamp: observation.timestamp,
      title: `${observation.senderName || observation.senderId} · ${sourceNames.value.get(observation.sourceId) ?? observation.groupId}`,
      detail: observation.text,
    }))
    const batches = snapshot.value.observationBatches.flatMap((batch) => {
      const changeCount = batch.expressionIds.length + batch.jargonIds.length + batch.behaviorIds.length
      const completed: AstrBotLearningMonitorEvent = {
        id: `batch:${batch.id}`,
        kind: 'batch',
        sourceId: batch.sourceId,
        timestamp: batch.processedAt,
        title: `${sourceNames.value.get(batch.sourceId) ?? batch.sourceId} · 完成一批归纳`,
        detail: batch.recoveredAt
          ? `${batch.messageCount} 条消息，已由后续批次补归纳`
          : changeCount > 0
            ? `${batch.messageCount} 条消息，更新 ${changeCount} 项，模型归纳`
            : `${batch.messageCount} 条消息，更新 0 项，待重新归纳`,
      }
      return batch.warning
        ? [
            completed,
            {
              id: `warning:${batch.id}`,
              kind: 'warning' as const,
              sourceId: batch.sourceId,
              timestamp: batch.processedAt,
              title: '模型归纳已回退',
              detail: batch.warning,
            },
          ]
        : [completed]
    })
    const stickers = (gatewayState.value?.stickerLibrary.recentEvents ?? []).map(event => ({
      id: `sticker:${event.id}`,
      kind: event.kind === 'warning' ? 'warning' as const : 'sticker' as const,
      sourceId: event.sourceId ?? '',
      timestamp: event.timestamp,
      title: ({
        collected: '收藏新表情',
        duplicate: '再次观察表情',
        discarded: '淘汰表情',
        sent: '私聊发送表情',
        warning: '表情包库异常',
      })[event.kind],
      detail: event.detail,
    }))
    return [...messages, ...batches, ...stickers]
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 50)
  })
  const recentChanges = computed<AstrBotLearningMonitorChange[]>(() => {
    const expressions = new Map(snapshot.value.expressions.map(item => [item.id, item]))
    const jargon = new Map(snapshot.value.jargon.map(item => [item.id, item]))
    const behaviors = new Map(snapshot.value.behaviors.map(item => [item.id, item]))
    return snapshot.value.observationBatches
      .flatMap(batch => [
        ...batch.expressionIds.flatMap((id) => {
          const item = expressions.get(id)
          return item
            ? [{
                id: `${batch.id}:expression:${id}`,
                kind: 'expression' as const,
                timestamp: batch.processedAt,
                label: item.phrase || item.patternType,
                detail: `${item.pragmaticFunction} · ${item.status} · 已观察 ${item.observationCount} 次`,
              }]
            : []
        }),
        ...batch.jargonIds.flatMap((id) => {
          const item = jargon.get(id)
          return item
            ? [{
                id: `${batch.id}:jargon:${id}`,
                kind: 'jargon' as const,
                timestamp: batch.processedAt,
                label: item.term,
                detail: item.meanings.at(-1)?.meaning ?? '已更新语用含义',
              }]
            : []
        }),
        ...batch.behaviorIds.flatMap((id) => {
          const item = behaviors.get(id)
          return item
            ? [{
                id: `${batch.id}:behavior:${id}`,
                kind: 'behavior' as const,
                timestamp: batch.processedAt,
                label: item.action,
                detail: item.situation,
              }]
            : []
        }),
      ])
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 50)
  })

  return {
    activeObservationBatches,
    changedKnowledgeCount,
    isReprocessing,
    missedMessageCount,
    pendingCount,
    processedMessageCount,
    recentObservationCount,
    resumePending,
    reprocessMissed,
    reprocessResult,
    recentChanges,
    recentEvents,
    stickerLibrary: computed(() => gatewayState.value?.stickerLibrary),
    sourceProgress,
    status,
  }
}
