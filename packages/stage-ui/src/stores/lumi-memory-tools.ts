import type { Tool } from '@xsai/shared-chat'

import type { LumiMemoryFragment, LumiRankedMemory } from '../../../lumi-runtime/src'

import { buildLumiContextualMemoryQuery, isContextDependentMemoryText } from '../../../lumi-runtime/src'
import { tool } from '@xsai/tool'
import { z } from 'zod'

import { LUMI_AIRI_CARD_ID } from '../constants/lumi-card'
import { extractMessageText } from '../libs/chat-sync'
import { useChatSessionStore } from './chat/session-store'
import { useLlmToolsStore } from './llm-tools'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useLumiMemoryStore } from './lumi-memory'
import { useAiriCardStore } from './modules/airi-card'

const LUMI_MEMORY_TOOLS_PROVIDER = 'lumi-memory'
export function registerLumiMemoryTools(options: {
  appendDebug?: (kind: 'memory_search', lines: string[]) => void
} = {}) {
  const toolsStore = useLlmToolsStore()
  const promptsStore = useLlmToolsetPromptsStore()

  toolsStore.registerTools(LUMI_MEMORY_TOOLS_PROVIDER, Promise.all([
    createLumiMemorySearchTool(options),
  ]))
  promptsStore.registerToolsetPrompts(LUMI_MEMORY_TOOLS_PROVIDER, [
    {
      id: 'lumi-memory-tool-guidance',
      title: 'Lumi Memory Tools',
      content: [
        'When the active persona is Lumi, long-term memory is available through tools, but it is not preloaded every turn.',
        'Use `lumi_memory_search` only when the user asks about past shared events, stored preferences, promises, personal facts, project continuity, or a context-dependent recall question such as "which entity/level/movie did I like?".',
        'Also use it before answering when the user mentions an unresolved concrete person, nickname, account name, character, place, project, event, shared experience, or relationship label that is not explained in the visible conversation and the reply needs to know what it is.',
        'Avoid `lumi_memory_search` for ordinary greetings, emotional acknowledgements, simple reasoning, current-turn questions, or when the answer is already present in the visible conversation.',
        'If the user corrects Lumi but asks to verify stored facts, search memory instead of defending the previous answer.',
        'If the user asks a specific memory question and no reliable memory is returned, say Lumi does not reliably remember that specific fact. Do not guess from personality, style guidance, or vague familiarity.',
        'Never invent a remembered experience or preference after a failed memory search.',
      ].join('\n'),
    },
  ])
}

export function clearLumiMemoryTools() {
  useLlmToolsStore().clearTools(LUMI_MEMORY_TOOLS_PROVIDER)
  useLlmToolsetPromptsStore().clearToolsetPrompts(LUMI_MEMORY_TOOLS_PROVIDER)
}

function createLumiMemorySearchTool(options: {
  appendDebug?: (kind: 'memory_search', lines: string[]) => void
}): Promise<Tool> {
  return tool({
    name: 'lumi_memory_search',
    description: 'Search Lumi long-term memory when the current reply needs stored personal facts, past shared events, promises, preferences, project continuity, or an unresolved concrete person/nickname/account/place/project/event/relationship mentioned by the user.',
    parameters: z.object({
      query: z.string().min(1).describe('The exact memory question or fact to recall. Include the user wording when possible.'),
      topic_window: z.string().optional().describe('Optional resolved conversation topic, e.g. "Backrooms entity preferences".'),
      topic_hints: z.array(z.string()).optional().describe('Optional topic markers such as Backrooms, entity, level, movie, project name.'),
      limit: z.number().int().min(1).max(10).optional().describe('Maximum memories to return. Defaults to 5.'),
    }).strict(),
    execute: async (payload) => {
      const cardStore = useAiriCardStore()
      cardStore.initialize()

      if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID) {
        return JSON.stringify({
          status: 'inactive_persona',
          message: 'Lumi memory is only available when the active AIRI card is Lumi.',
          memories: [],
        })
      }

      const memoryStore = useLumiMemoryStore()
      memoryStore.initialize()
      const sessionStore = useChatSessionStore()
      const sessionId = sessionStore.activeSessionId
      const recentMessages = sessionId
        ? sessionStore.getSessionMessages(sessionId)
            .filter(message => message.role === 'user')
            .slice(-8)
            .map(message => ({ role: message.role, content: extractMessageText(message).slice(0, 600) }))
            .filter(message => message.content.trim() && !/^\[(?:memory_search|memory_write)\]/.test(message.content.trim()))
        : []
      const contextual = buildLumiContextualMemoryQuery({
        currentMessage: payload.query,
        recentMessages,
      })
      const topicWindow = payload.topic_window || contextual.topicWindow
      const topicHints = [...new Set([...(payload.topic_hints ?? []), ...contextual.topicHints])].slice(0, 8)
      const query = [
        payload.query,
        topicHints.length ? `Resolved topic hints: ${topicHints.join(', ')}` : '',
        topicWindow ? `Recent topic window: ${topicWindow}` : '',
      ].filter(Boolean).join('\n')
      const result = await memoryStore.retrieveSemantic({
        query,
        userId: 'local',
        personaId: LUMI_AIRI_CARD_ID,
        limit: payload.limit ?? 5,
      })
      const memories = result.rankedMemories
        .filter(item => isUsableLumiToolMemory(item, result.route.queryIntent))
        .filter(item => isSpecificMemoryAnswerEvidence(item.memory, payload.query, topicHints, topicWindow))
        .slice(0, payload.limit ?? 5)

      const status = memories.length ? 'evidence_found' : 'no_reliable_answer_memory'
      const bestEvidence = memories[0]?.memory
      options.appendDebug?.('memory_search', [
        'tool: lumi_memory_search',
        `query: ${previewText(payload.query)}`,
        topicWindow ? `context: ${previewText(topicWindow)}` : 'context: none',
        `route: ${result.route.queryIntent}`,
        `vector: ${describeMemoryVectorPath(result)}`,
        `semantic_status: ${memoryStore.semanticIndexStatus}`,
        `semantic_device: ${memoryStore.semanticIndexDevice}`,
        `semantic_indexed: ${memoryStore.semanticIndexedCount}/${memoryStore.allMemories.length}`,
        `semantic_search_pool: ${memoryStore.semanticSearchPoolSize}`,
        memoryStore.semanticIndexProgress ? `semantic_progress: ${previewText(memoryStore.semanticIndexProgress, 160)}` : '',
        memoryStore.semanticIndexError ? `semantic_error: ${previewText(memoryStore.semanticIndexError, 160)}` : '',
        `answer_evidence: ${memories.length}`,
        `status: ${status}`,
        bestEvidence ? `best_evidence: ${previewText(bestEvidence.content, 180)}` : '',
        memories.length ? '' : 'rule: do not answer this recall from style/persona memories or guesses',
        ...memories.slice(0, 3).map(item => `- ${item.memory.type} score=${item.finalScore.toFixed(2)}: ${previewText(item.memory.content, 90)}`),
      ].filter(Boolean))

      return JSON.stringify({
        status,
        query: payload.query,
        topicWindow,
        route: result.route.queryIntent,
        answerEvidence: bestEvidence
          ? {
              id: bestEvidence.id,
              type: bestEvidence.type,
              content: bestEvidence.content,
              tags: bestEvidence.tags,
            }
          : null,
        memories: memories.map(item => ({
          id: item.memory.id,
          type: item.memory.type,
          content: item.memory.content,
          tags: item.memory.tags,
          confidence: item.memory.confidence,
          importance: item.memory.importance,
          finalScore: Number(item.finalScore.toFixed(3)),
          scoreBreakdown: item.scoreBreakdown,
        })),
        instruction: memories.length
          ? 'Use answerEvidence.content and memories[].content as the only long-term recall evidence. For exact recall questions, answer from the returned content verbatim or with a faithful direct summary. Do not add unstored details, new labels, or guesses.'
          : 'No reliable long-term memory answered the query. Say Lumi does not reliably remember this specific fact; do not guess or invent.',
      })
    },
  })
}

export function shouldSkipLumiMemorySearch(query: string) {
  const text = query.trim()
  if (!text)
    return 'empty_query'

  const cleanGuardDecision = classifyLumiMemorySearchGuard(text)
  if (cleanGuardDecision !== null)
    return cleanGuardDecision

  if (isExplicitRecallQuery(text))
    return ''

  if (isContextDependentMemoryText(text))
    return ''

  if (hasUnresolvedConcreteEntityMention(text))
    return ''

  if (/^(你好|嗨|哈喽|啊+|嗯+|哦+|行吧|好吧|可以|谢谢|辛苦|我懂|懂了|没事|算了|继续|说吧)[。！？!?\s]*$/i.test(text))
    return 'routine_acknowledgement'

  if (/(换个话题|不聊这个|别说这个|算了|不是这个|你说错了|我不是问这个|别重复|停)/.test(text))
    return 'topic_change_or_correction'

  if (text.length <= 18)
    return 'short_non_recall_message'

  return 'no_recall_intent'
}

function classifyLumiMemorySearchGuard(text: string): string | null {
  if (isCleanExplicitRecallQuery(text))
    return ''

  if (isCleanRoutineAcknowledgement(text))
    return 'routine_acknowledgement'

  if (isCleanTopicChangeOrCorrection(text))
    return 'topic_change_or_correction'

  return null
}

function isCleanRoutineAcknowledgement(text: string) {
  return /^(\u4f60\u597d|\u55e8|\u54c8\u55bd|\u554a|\u55ef|\u54e6|\u884c\u5427|\u597d\u5427|\u53ef\u4ee5|\u8c22\u8c22|\u8f9b\u82e6|\u6211\u61c2|\u61c2\u4e86|\u6ca1\u4e8b|\u7b97\u4e86|\u7ee7\u7eed|\u8bf4\u5427)[\u3002\uff01\uff1f!?,\uff0c\s]*$/i.test(text)
}

function isCleanTopicChangeOrCorrection(text: string) {
  return /(\u6362\u4e2a\u8bdd\u9898|\u4e0d\u804a\u8fd9\u4e2a|\u522b\u8bf4\u8fd9\u4e2a|\u4e0d\u662f\u8fd9\u4e2a|\u4f60\u8bf4\u9519\u4e86|\u6211\u4e0d\u662f\u95ee\u8fd9\u4e2a|\u522b\u91cd\u590d|\u505c)/.test(text)
}

function isCleanExplicitRecallQuery(text: string) {
  return /(\u8bb0\u5f97|\u8fd8\u8bb0\u5f97|\u60f3\u8d77\u6765|\u56de\u5fc6|\u957f\u671f\u8bb0\u5fc6|\u8bb0\u5fc6\u91cc|\u4e0a\u6b21|\u4e4b\u524d|\u4ee5\u524d|\u90a3\u5929|\u53d1\u751f\u4e86\u4ec0\u4e48|\u6211\u559c\u6b22|\u6211\u6700\u559c\u6b22|\u6211\u8bf4\u8fc7|\u4f60\u7b54\u5e94|\u7ea6\u5b9a|\u627f\u8bfa|\u504f\u597d|\u54ea\u4e00|\u54ea\u4e00\u4e2a|\u54ea\u90e8|\u54ea\u5929|\u4ec0\u4e48\u65f6\u5019|\u662f\u8c01|\u8c01\u662f|\u53eb\u4ec0\u4e48|\u540d\u5b57|\u5973\u670b\u53cb|\u7537\u670b\u53cb|\u597d\u53cb|\u670b\u53cb|\u5907\u6ce8|\u6635\u79f0|\u7528\u6237\u540d|\u8d26\u53f7|\u8d26\u6237|remember|recall|previously|before)/i.test(text)
}

function isExplicitRecallQuery(text: string) {
  return /(记得|还记得|想起来|回忆|上次|之前|以前|那天|发生了什么|我喜欢|我最喜欢|我说过|你答应|约定|承诺|偏好|哪一|哪个|哪部|哪天|什么时候|remember|recall|previously|before)/i.test(text)
}

function hasUnresolvedConcreteEntityMention(text: string) {
  const ignored = new Set(['airi', 'lumi', 'doggy', 'personaos', 'ai'])
  const latinNames = text.match(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g) ?? []
  return latinNames.some(name => !ignored.has(name.toLowerCase()))
}

function describeMemoryVectorPath(result: { vectorUsed: boolean, vectorSource?: string, vectorFallback?: string }) {
  if (result.vectorUsed && result.vectorSource === 'external')
    return 'semantic_vector'
  if (result.vectorUsed && result.vectorSource === 'deterministic')
    return 'deterministic_fallback'
  return result.vectorFallback || 'lexical_fallback'
}

function isUsableLumiToolMemory(item: LumiRankedMemory, intent: string) {
  if (item.finalScore < 0.34)
    return false

  if (intent === 'memory_recall' && item.scoreBreakdown.semanticScore < 0.18)
    return false

  if (intent === 'casual' && item.scoreBreakdown.semanticScore < 0.12)
    return false

  return true
}

function isSpecificMemoryAnswerEvidence(memory: LumiMemoryFragment, messageText: string, topicHints: string[], topicWindow: string) {
  const markerGroups = buildSpecificRecallEvidenceMarkers(messageText, topicHints, topicWindow)
  if (!markerGroups.specific.length && !markerGroups.topic.length)
    return true

  const haystack = `${memory.type} ${memory.tags.join(' ')} ${memory.content}`.toLowerCase()
  const matchesSpecific = !markerGroups.specific.length
    || markerGroups.specific.some(marker => haystack.includes(marker))
  const matchesTopic = !markerGroups.topic.length
    || markerGroups.topic.some(marker => haystack.includes(marker))
  return matchesSpecific && matchesTopic
}

function buildSpecificRecallEvidenceMarkers(messageText: string, topicHints: string[], topicWindow: string) {
  const text = `${messageText} ${topicWindow}`.toLowerCase()
  const specific: string[] = []
  const topic: string[] = []

  const addSpecific = (...markers: string[]) => {
    for (const marker of markers)
      specific.push(marker.toLowerCase())
  }
  const addTopic = (...markers: string[]) => {
    for (const marker of markers)
      topic.push(marker.toLowerCase())
  }

  if (/\bentities?\b|\u5b9e\u4f53/.test(text))
    addSpecific('entity', '\u5b9e\u4f53')
  if (/\blevels?\b|\u5c42\u7ea7|\u5c42/.test(text))
    addSpecific('level', '\u5c42\u7ea7', '\u5c42')
  if (/\bcharacters?\b|\u89d2\u8272/.test(text))
    addSpecific('character', '\u89d2\u8272')
  if (/\bmovies?\b|\bfilms?\b|\u7535\u5f71/.test(text))
    addSpecific('movie', 'film', '\u7535\u5f71')
  if (/\bgames?\b|\u6e38\u620f/.test(text))
    addSpecific('game', '\u6e38\u620f')
  if (/\bitems?\b|\u7269\u54c1|\u9053\u5177/.test(text))
    addSpecific('item', '\u7269\u54c1', '\u9053\u5177')
  if (/\bplaces?\b|\blocations?\b|\u5730\u65b9|\u54ea\u91cc/.test(text))
    addSpecific('place', 'location', '\u5730\u65b9')
  if (/\btone\b|\u8bed\u6c14/.test(text))
    addSpecific('tone', '\u8bed\u6c14')

  const topicText = `${topicHints.join(' ')} ${topicWindow}`.toLowerCase()
  if (/\bbackrooms?\b|\u540e\u5ba4/.test(topicText))
    addTopic('backrooms', '\u540e\u5ba4')
  if (/\bscp\b/.test(topicText))
    addTopic('scp')
  if (/\bminecraft\b|\u6211\u7684\u4e16\u754c/.test(topicText))
    addTopic('minecraft', '\u6211\u7684\u4e16\u754c')

  return {
    specific: [...new Set(specific)],
    topic: [...new Set(topic)],
  }
}

function previewText(text: string, maxLength = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized
}
