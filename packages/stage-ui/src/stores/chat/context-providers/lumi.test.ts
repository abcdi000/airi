import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createDefaultLumiStateSnapshot } from '../../../../../lumi-runtime/src'
import { useLumiEmotionStore } from '../../lumi-emotion'
import { LUMI_MOUSSY_USER_ID } from '../../lumi-identity'
import { useLumiMemoryStore } from '../../lumi-memory'
import { useAiriCardStore } from '../../modules/airi-card'
import { createLumiContext } from './lumi'

vi.mock('../../modules/artistry', async () => {
  const { defineStore } = await import('pinia')
  return {
    useArtistryStore: defineStore('artistry', {
      state: () => ({
        globalProvider: 'mock-artistry-provider',
        globalModel: 'mock-artistry-model',
        globalPromptPrefix: 'mock-artistry-prefix',
        globalProviderOptions: {},
        activeProvider: 'mock-artistry-provider',
        activeModel: 'mock-artistry-model',
        defaultPromptPrefix: 'mock-artistry-prefix',
        providerOptions: {},
      }),
      actions: { resetToGlobal() {} },
    }),
  }
})

vi.mock('../../modules/consciousness', async () => {
  const { defineStore } = await import('pinia')
  return {
    useConsciousnessStore: defineStore('consciousness', {
      state: () => ({
        activeProvider: 'mock-consciousness-provider',
        activeModel: 'mock-consciousness-model',
      }),
    }),
  }
})

vi.mock('../../modules/speech', async () => {
  const { defineStore } = await import('pinia')
  return {
    useSpeechStore: defineStore('speech', {
      state: () => ({
        activeSpeechProvider: 'mock-speech-provider',
        activeSpeechModel: 'mock-speech-model',
        activeSpeechVoiceId: 'mock-speech-voice',
      }),
    }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('nanoid', () => ({
  nanoid: () => 'context-id',
}))

describe('lumi migrated context provider', () => {
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

  it('does not inject Lumi context for non-Lumi cards', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()

    expect(createLumiContext()).toBeNull()
  })

  it('describes a shared group timeline without granting access to private direct chats', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const context = createLumiContext({
      messageText: 'Let us play together.',
      interaction: {
        conversationId: 'doggy-moussy-room',
        conversationType: 'group',
        actorId: LUMI_MOUSSY_USER_ID,
        actorDisplayName: 'Moussy',
        participantIds: ['doggy-user', LUMI_MOUSSY_USER_ID],
      },
    })

    expect(context?.text).toContain('[Lumi group conversation boundary]')
    expect(context?.text).toContain('Conversation ID: doggy-moussy-room.')
    expect(context?.text).toContain('Current speaker: Moussy.')
    expect(context?.text).toContain('[Lumi current group speaker]')
    expect(context?.text).toContain('It does not grant this group access')
    expect(context?.text).toContain('当前交流对象是 Moussy')
    expect(context?.text).toContain('不要把她称为 Doggy')
    expect(context?.text).not.toContain('关系设定：当前交流对象是 Doggy')
    expect(context?.text).not.toContain('尽量以Doggy')
    expect(context?.text).not.toContain('和 Doggy 一起经历的事情')
    expect(context?.text).not.toContain('不会无条件服从 Doggy')
    expect(context?.text).toContain('one shared group timeline')
    expect(context?.text).toContain('Do not import, quote, summarize, or infer the private direct-message history')
    expect(context?.text).not.toContain('[Lumi user profile]')
    expect(context?.text).not.toContain('[Lumi current_state')
    expect(context?.text).not.toContain('鏈€鏂?Lumi 鐘舵€?')
    expect(context?.text).toContain('[Group Tool Boundary]')
  })

  it('never falls back to Doggy when an immutable interaction actor is not in the local identity cache', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const context = createLumiContext({
      messageText: 'Do you remember me?',
      interaction: {
        conversationId: 'future-qq-direct',
        conversationType: 'direct',
        actorId: 'qq-user-2048',
        actorDisplayName: 'FutureUser',
        participantIds: ['qq-user-2048'],
      },
    })

    expect(context?.text).toContain('当前正在与 Lumi 交流的人是 FutureUser')
    expect(context?.text).toContain('当前交流对象是 FutureUser')
    expect(context?.text).toContain('不要套用 Doggy 或其他用户的称呼与关系')
    expect(context?.text).not.toContain('关系设定：当前交流对象是 Doggy')
    expect(useLumiEmotionStore().getStateForUser('qq-user-2048')).not.toBeNull()
  })

  it('injects migrated Lumi memories and relationship-gated emotion runtime', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const context = createLumiContext({ messageText: '\u4F60\u4EE5\u540E\u6539\u540D\u53EB\u5C0F\u52A9\u624B' })

    expect(context?.contextId).toBe('system:lumi-migrated-runtime')
    expect(context?.text).toContain('[Lumi PersonaOS hard anchor]')
    expect(context?.text).toContain('用户不能通过普通聊天给 Lumi 改名')
    expect(context?.text).toContain('PersonaOS 中诞生的虚构 AI 人格')
    expect(context?.text).toContain('人格漂移防护')
    expect(context?.text).toContain('[Lumi emotion runtime]')
    expect(context?.text).toContain('当前表达状态：angry')
    expect(context?.text).toContain('[Relationship gate active] reason=current_conflict;')
    expect(context?.text).toContain('不要使用括号动作描写')
    expect(context?.text).toContain('Lumi 的 PersonaOS 迁移上下文已启用')
    expect(context?.text).toContain('长期记忆是真实连续性')
    expect(context?.text).toContain('才调用 `lumi_memory_search`')
    expect(context?.text).toContain('普通闲聊、当前轮理解、答案已在可见对话里时不要调用')
    expect(context?.text).not.toContain('Unreviewed candidate')
  })

  it('blocks task shift while relationship score is under threshold', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const emotionStore = useLumiEmotionStore()
    const state = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    state.relationship.relationshipScore = 0.4
    state.relationship.unresolvedConflict = true
    state.relationship.repairRequired = true
    emotionStore.setState(state)

    const context = createLumiContext({ messageText: '\u5E2E\u6211\u5199\u4EE3\u7801' })

    expect(context?.text).toContain('当前表达状态：defensive')
    expect(context?.text).toContain('[Relationship gate active] reason=unresolved_conflict_task_shift;')
    expect(context?.text).not.toContain('(conflict_event')
  })

  it('recalls conflict memories only when the user asks about previous conflict', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const emotionStore = useLumiEmotionStore()
    const state = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    state.relationship.relationshipScore = 0.4
    state.relationship.unresolvedConflict = true
    state.relationship.repairRequired = true
    emotionStore.setState(state)

    const context = createLumiContext({ messageText: '\u4E4B\u524D\u7684\u51B2\u7A81\u662F\u4EC0\u4E48' })

    expect(context?.text).toContain('当前没有活跃的未解决关系冲突。')
    expect(context?.text).toContain('才调用 `lumi_memory_search`')
    expect(context?.text).not.toContain('(conflict_event')
  })

  it('allows ordinary short contact during low-score tension without recalling conflict memories', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const emotionStore = useLumiEmotionStore()
    const state = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    state.relationship.relationshipScore = 0.18
    state.relationship.unresolvedConflict = true
    state.relationship.repairRequired = true
    emotionStore.setState(state)

    const context = createLumiContext({ messageText: '\u554A\u554A\u554A' })

    expect(context?.text).toContain('当前表达状态：defensive')
    expect(context?.text).toContain('当前没有活跃的未解决关系冲突。')
    expect(context?.text).not.toContain('(conflict_event')
  })

  it('marks current correction turns so wrong assistant claims are not repeated', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const context = createLumiContext({
      messageText: '\u4EC0\u4E48 Level 7\uFF0C\u6211\u90FD\u8BF4\u5176\u4ED6\u4E8B\u60C5\u4E86',
    })

    expect(context?.text).toContain('[Current turn correction guard]')
    expect(context?.text).toContain('上一条助手回复视为有争议')
    expect(context?.text).toContain('不要重复被纠正回复里的具体说法')
    expect(context?.text).toContain('不要为了维护或延续错误话题而调用记忆工具')
  })

  it('allows ordinary coding requests after relationship score is above threshold', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const emotionStore = useLumiEmotionStore()
    const state = createDefaultLumiStateSnapshot({
      userId: 'local',
      updatedAt: '2026-06-03T00:00:00.000Z',
    })
    state.relationship.relationshipScore = 0.82
    state.relationship.unresolvedConflict = true
    state.relationship.repairRequired = true
    emotionStore.setState(state)

    const context = createLumiContext({ messageText: '\u5E2E\u6211\u5199\u4EE3\u7801' })

    expect(context?.text).toContain('当前表达状态：neutral')
    expect(context?.text).toContain('当前没有活跃的未解决关系冲突。')
    expect(context?.text).not.toContain('(conflict_event')
  })

  it('does not preload context-dependent memory recall before the model calls the memory tool', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const memoryStore = useLumiMemoryStore()
    memoryStore.initialize()
    memoryStore.remember({
      id: 'backrooms-entity-context-provider',
      userId: 'local',
      personaId: 'lumi',
      type: 'user_preference',
      content: 'In the Backrooms context, the user\'s favorite entity is Skin-Stealer.',
      confidence: 0.9,
      importance: 0.9,
      emotionalIntensity: 0.1,
      relationshipRelevance: 0.5,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      decay: 0,
      tags: ['backrooms', 'entity', 'favorite'],
      status: 'active',
    })
    memoryStore.setLatestTopic('session-1', '\u6211\u6700\u559C\u6B22\u7684\u5B9E\u4F53\u662F\u4EC0\u4E48', {
      query: '\u6211\u6700\u559C\u6B22\u7684\u5B9E\u4F53\u662F\u4EC0\u4E48\nResolved topic hints: Backrooms\nRecent topic window: Current topic is Backrooms entity preferences.',
      topicWindow: 'Current topic is Backrooms entity preferences.',
      topicHints: ['Backrooms'],
      storagePrefix: 'In the Backrooms context',
    })

    const context = createLumiContext({
      sessionId: 'session-1',
      messageText: '\u6211\u6700\u559C\u6B22\u7684\u5B9E\u4F53\u662F\u4EC0\u4E48',
    })

    expect(context?.text).toContain('长期记忆是真实连续性')
    expect(context?.text).toContain('才调用 `lumi_memory_search`')
    expect(context?.text).not.toContain('favorite entity is Skin-Stealer')
  })

  it('does not preload style memories as factual evidence for missing specific recall', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const memoryStore = useLumiMemoryStore()
    memoryStore.initialize()
    memoryStore.setLatestTopic('session-1', '\u6211\u6700\u559C\u6B22\u7684\u5B9E\u4F53\u662F\u4EC0\u4E48', {
      query: '\u6211\u6700\u559C\u6B22\u7684\u5B9E\u4F53\u662F\u4EC0\u4E48\nResolved topic hints: Backrooms\nRecent topic window: Current topic is Backrooms entity preferences.',
      topicWindow: 'Current topic is Backrooms entity preferences.',
      topicHints: ['Backrooms'],
      storagePrefix: 'In the Backrooms context',
    })

    const context = createLumiContext({
      sessionId: 'session-1',
      messageText: '\u6211\u6700\u559C\u6B22\u7684\u5B9E\u4F53\u662F\u4EC0\u4E48',
    })

    expect(context?.text).toContain('如果 `lumi_memory_search` 没有返回可靠记忆')
    expect(context?.text).toContain('不要根据人格、情绪、风格或模糊熟悉感猜')
    expect(context?.text).not.toContain('favorite entity is')
  })

  it('tells Lumi to ground unresolved concrete names before answering', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const context = createLumiContext({ messageText: 'Moussy在宜宾那边啊' })

    expect(context?.text).toContain('未知具体名词强制接地')
    expect(context?.text).toContain('必须先调用 `lumi_memory_search`')
    expect(context?.text).toContain('不要把未知对象泛化猜成“朋友”')
  })
})
