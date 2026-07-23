import type { Tool, ToolExecuteOptions } from '@xsai/shared-chat'

import type { ChatInteractionContext } from '../types/chat'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { bindLumiMemoryToolsForTurn } from './lumi-memory-tools'

const retrieveSemanticMock = vi.fn()
const getSessionMessagesMock = vi.fn()

vi.mock('./modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCardId: 'lumi',
    initialize: vi.fn(),
  }),
}))

vi.mock('./lumi-memory', () => ({
  useLumiMemoryStore: () => ({
    allMemories: [],
    initialize: vi.fn(),
    retrieveSemantic: retrieveSemanticMock,
    semanticIndexDevice: 'test',
    semanticIndexError: '',
    semanticIndexProgress: '',
    semanticIndexedCount: 0,
    semanticIndexStatus: 'ready',
    semanticSearchPoolSize: 0,
  }),
}))

vi.mock('./chat/session-store', () => ({
  useChatSessionStore: () => ({
    getSessionMessages: getSessionMessagesMock,
  }),
}))

function interaction(
  actorId: string,
  conversationId: string,
  participantIds: string[],
): ChatInteractionContext {
  return {
    actorId,
    actorDisplayName: actorId,
    conversationId,
    conversationType: participantIds.length > 1 ? 'group' : 'direct',
    participantIds,
  }
}

function memoryTool(tools: Tool[]) {
  const result = tools.find(tool => tool.function?.name === 'lumi_memory_search')
  if (!result?.execute)
    throw new Error('Expected a bound Lumi memory tool')
  return result
}

/**
 * @example
 * Two concurrent turns resolve separate memory-tool closures.
 */
describe('bindLumiMemoryToolsForTurn', () => {
  beforeEach(() => {
    retrieveSemanticMock.mockReset().mockResolvedValue({
      rankedMemories: [],
      route: { queryIntent: 'memory_recall' },
      vectorFallback: 'test',
      vectorUsed: false,
    })
    getSessionMessagesMock.mockReset().mockReturnValue([])
  })

  /**
   * @example
   * Doggy and Moussy query memory simultaneously without sharing ACL inputs.
   */
  it('keeps identity and conversation ACL inputs isolated per resolved tool', async () => {
    const unrelatedTool = { type: 'function', function: { name: 'other_tool' } } as Tool
    const doggyContext = interaction('doggy-user', 'doggy-session', ['doggy-user'])
    const moussyContext = interaction('moussy-user', 'group-session', ['doggy-user', 'moussy-user'])
    const doggyTools = await bindLumiMemoryToolsForTurn([unrelatedTool], {
      interaction: doggyContext,
      sessionId: 'doggy-session',
    })()
    const moussyTools = await bindLumiMemoryToolsForTurn([unrelatedTool], {
      interaction: moussyContext,
      sessionId: 'group-session',
    })()

    await Promise.all([
      memoryTool(doggyTools).execute?.({ query: 'What is my birthday?' }, {} as ToolExecuteOptions),
      memoryTool(moussyTools).execute?.({ query: 'What happened in our group?' }, {} as ToolExecuteOptions),
    ])

    expect(doggyTools.filter(tool => tool.function?.name === 'lumi_memory_search')).toHaveLength(1)
    expect(moussyTools.filter(tool => tool.function?.name === 'lumi_memory_search')).toHaveLength(1)
    expect(doggyTools).toContain(unrelatedTool)
    expect(moussyTools).toContain(unrelatedTool)
    expect(getSessionMessagesMock).toHaveBeenCalledWith('doggy-session')
    expect(getSessionMessagesMock).toHaveBeenCalledWith('group-session')
    expect(retrieveSemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'doggy-user',
      viewerUserId: 'doggy-user',
      conversationId: 'doggy-session',
      participantUserIds: ['doggy-user'],
    }))
    expect(retrieveSemanticMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'moussy-user',
      viewerUserId: 'moussy-user',
      conversationId: 'group-session',
      participantUserIds: ['doggy-user', 'moussy-user'],
    }))
  })

  /**
   * @example
   * A globally registered fallback tool cannot query memory without turn identity.
   */
  it('fails closed when immutable interaction context is absent', async () => {
    const tools = await bindLumiMemoryToolsForTurn(undefined, {})()
    const result = await memoryTool(tools).execute?.({ query: 'secret' }, {} as ToolExecuteOptions)

    expect(result).toContain('missing_interaction_context')
    expect(retrieveSemanticMock).not.toHaveBeenCalled()
  })
})
