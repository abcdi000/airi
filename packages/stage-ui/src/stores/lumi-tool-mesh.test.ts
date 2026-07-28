import type { LumiToolDefinition } from './lumi-tool-mesh'

import { createTestingPinia } from '@pinia/testing'
import { tool } from '@xsai/tool'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { useLumiMemoryStore } from './lumi-memory'
import {
  bindLumiToolMeshToolsForTurn,
  orderToolPlanSteps,
  parseLumiModelDecision,
  useLumiToolMeshStore,
} from './lumi-tool-mesh'

function makeStorage() {
  const values: Record<string, string> = {}
  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { values[key] = value }),
      removeItem: vi.fn((key: string) => { delete values[key] }),
      clear: vi.fn(() => { Object.keys(values).forEach(key => delete values[key]) }),
      key: vi.fn((index: number) => Object.keys(values)[index] ?? null),
      get length() { return Object.keys(values).length },
    } as unknown as Storage,
  }
}

function toolDef(patch: Partial<LumiToolDefinition> & Pick<LumiToolDefinition, 'id'>): LumiToolDefinition {
  return {
    id: patch.id,
    name: patch.name ?? patch.id,
    description: patch.description ?? patch.id,
    capabilities: patch.capabilities ?? [],
    examples: patch.examples ?? [],
    inputSchema: patch.inputSchema ?? {},
    outputSchema: patch.outputSchema ?? {},
    riskLevel: patch.riskLevel ?? 'low',
    accessScopes: patch.accessScopes ?? ['chat'],
    executionMode: patch.executionMode ?? 'auto',
    status: patch.status ?? 'implemented',
    implementationPath: patch.implementationPath,
    canRead: patch.canRead ?? true,
    canWrite: patch.canWrite ?? false,
    canExecuteProcess: patch.canExecuteProcess ?? false,
    canAccessNetwork: patch.canAccessNetwork ?? false,
    canModifySettings: patch.canModifySettings ?? false,
    canTouchUserFiles: patch.canTouchUserFiles ?? false,
    canTouchLumiCore: patch.canTouchLumiCore ?? false,
    suggestedCombinations: patch.suggestedCombinations,
  }
}

describe('lumi tool mesh', () => {
  beforeEach(() => {
    const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false })
    setActivePinia(pinia)
    const { storage } = makeStorage()
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses JSON tool decisions from model text', () => {
    const parsed = parseLumiModelDecision(`
\`\`\`json
{
  "mode": "use_tools",
  "goal": "answer from project memory",
  "reason": "need current self project context",
  "toolPlan": [
    { "id": "a", "toolId": "search_lumi_self_projects", "purpose": "find project", "input": { "query": "LumiWorld" } }
  ]
}
\`\`\`
`)

    expect(parsed?.mode).toBe('use_tools')
    expect(parsed?.mode === 'use_tools' ? parsed.toolPlan[0].toolId : '').toBe('search_lumi_self_projects')
  })

  it('orders dependent steps and reports unresolved dependencies', () => {
    const { ordered, skipped } = orderToolPlanSteps([
      { id: 'b', toolId: 'second', purpose: 'second', input: {}, dependsOn: ['a'] },
      { id: 'a', toolId: 'first', purpose: 'first', input: {} },
      { id: 'c', toolId: 'missing_dep', purpose: 'bad', input: {}, dependsOn: ['z'] },
    ])

    expect(ordered.map(step => step.id)).toEqual(['a', 'b'])
    expect(skipped).toHaveLength(1)
    expect(skipped[0].stepId).toBe('c')
  })

  it('executes a low risk tool plan and records logs', async () => {
    const store = useLumiToolMeshStore()
    store.registerToolDefinitions('test', [
      toolDef({ id: 'echo' }),
    ], {
      echo: input => ({ ok: true, input }),
    })

    const result = await store.executeToolPlan({
      goal: 'echo',
      toolPlan: [{ id: 's1', toolId: 'echo', purpose: 'echo input', input: { text: 'hi' } }],
    }, { scope: 'chat', source: 'test' })

    expect(result.status).toBe('success')
    expect(store.toolUseLogs[0].toolId).toBe('echo')
    expect(store.recentPlans[0].status).toBe('executed')
  })

  it('blocks operator-present tools until operator mode is enabled', async () => {
    const store = useLumiToolMeshStore()
    store.operatorPresentMode = false
    store.registerToolDefinitions('test', [
      toolDef({ id: 'write_note', riskLevel: 'medium', executionMode: 'operator_present_auto', canWrite: true }),
    ], {
      write_note: () => ({ stored: true }),
    })

    const blocked = await store.executeTool('write_note', {}, { scope: 'chat', source: 'test' })
    expect(blocked.status).toBe('pending_confirmation')

    store.operatorPresentMode = true
    const allowed = await store.executeTool('write_note', {}, { scope: 'chat', source: 'test' })
    expect(allowed.status).toBe('success')
  })

  it('does not execute high risk confirm tools through normal chat scope', async () => {
    const store = useLumiToolMeshStore()
    store.registerToolDefinitions('test', [
      toolDef({ id: 'run_agent', riskLevel: 'high', executionMode: 'confirm', canExecuteProcess: true }),
    ], {
      run_agent: () => ({ ran: true }),
    })

    const result = await store.executeTool('run_agent', {}, { scope: 'chat', source: 'test' })
    expect(result.status).toBe('pending_confirmation')
    expect(store.waitingForConfirmation).toBe(true)
  })

  it('blocks direct-user tools in group plans without calling their executors', async () => {
    const store = useLumiToolMeshStore()
    const searchPrivateNotes = vi.fn(() => ({ notes: ['private'] }))
    store.registerToolDefinitions('test', [
      toolDef({ id: 'search_private_notes' }),
    ], {
      search_private_notes: searchPrivateNotes,
    })

    const result = await store.executeToolPlan({
      goal: 'read private data',
      toolPlan: [{ id: 'private', toolId: 'search_private_notes', purpose: 'read notes', input: {} }],
    }, {
      scope: 'chat',
      source: 'test',
      conversationId: 'group-doggy-moussy',
      conversationType: 'group',
      actorId: 'moussy',
      participantIds: ['doggy', 'moussy'],
    })

    expect(result.status).toBe('failed')
    expect(result.executed[0].status).toBe('blocked')
    expect(result.executed[0].blockedReason).toContain('unavailable in user-facing chat')
    expect(searchPrivateNotes).not.toHaveBeenCalled()
  })

  it('keeps direct-user profile tools available in their direct conversation', async () => {
    const store = useLumiToolMeshStore()
    const readUserProfile = vi.fn(() => ({ entries: ['profile'] }))
    store.registerToolDefinitions('test', [
      toolDef({ id: 'read_user_profile' }),
    ], {
      read_user_profile: readUserProfile,
    })

    const result = await store.executeTool('read_user_profile', {}, {
      scope: 'chat',
      source: 'test',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      actorId: 'doggy',
      participantIds: ['doggy'],
    })

    expect(result.status).toBe('success')
    expect(readUserProfile).toHaveBeenCalledOnce()
  })

  it('keeps long-term memory search available to the Agent Runtime in direct chat', () => {
    const store = useLumiToolMeshStore()
    store.initializeCoreTools()

    const definition = store.definitionById('search_long_memory')

    expect(definition).toBeDefined()
    expect(definition?.accessScopes).toContain('chat')
    expect(definition?.executionMode).toBe('auto')
  })

  it('passes the immutable Agent Runtime identity into long-term memory retrieval', async () => {
    const store = useLumiToolMeshStore()
    const memory = useLumiMemoryStore()
    const retrieveSemantic = vi.spyOn(memory, 'retrieveSemantic').mockResolvedValue({
      route: {
        preferredTypes: [],
        queryIntent: 'memory_recall',
        reason: 'test',
      },
      rankedMemories: [],
      vectorUsed: false,
      vectorSource: 'disabled',
      vectorScores: {},
    })
    store.initializeCoreTools()

    const result = await store.executeTool('search_long_memory', {
      query: 'Lumi 的生日',
    }, {
      scope: 'chat',
      source: 'shared_agent_runtime',
      conversationId: 'direct-moussy',
      conversationType: 'direct',
      actorId: 'moussy',
      participantIds: ['moussy'],
    })

    expect(result.status).toBe('success')
    expect(retrieveSemantic).toHaveBeenCalledWith(expect.objectContaining({
      query: 'Lumi 的生日',
      userId: 'moussy',
      viewerUserId: 'moussy',
      conversationType: 'direct',
      conversationId: 'direct-moussy',
      participantUserIds: ['moussy'],
    }))
  })

  it('blocks Lumi-private records even in a direct user chat', async () => {
    const store = useLumiToolMeshStore()
    const searchPrivateNotes = vi.fn(() => ({ notes: ['private'] }))
    store.registerToolDefinitions('test', [
      toolDef({ id: 'search_private_notes' }),
    ], {
      search_private_notes: searchPrivateNotes,
    })

    const result = await store.executeTool('search_private_notes', {}, {
      scope: 'chat',
      source: 'test',
      conversationId: 'direct-moussy',
      conversationType: 'direct',
      actorId: 'moussy',
      participantIds: ['moussy'],
    })

    expect(result.status).toBe('blocked')
    expect(result.blockedReason).toContain('unavailable in user-facing chat')
    expect(searchPrivateNotes).not.toHaveBeenCalled()
  })

  it('omits direct-user tools from group prompt guidance', () => {
    const store = useLumiToolMeshStore()
    store.registerToolDefinitions('test', [
      toolDef({ id: 'search_private_notes' }),
      toolDef({ id: 'list_lumiworld_artifacts' }),
    ])

    const guidance = store.buildPromptGuidance('chat', 'group')

    expect(guidance).not.toContain('internal toolId: search_private_notes')
    expect(guidance).toContain('internal toolId: list_lumiworld_artifacts')
    expect(guidance).toContain('[Group Tool Boundary]')
  })

  it('removes model-facing diary tools from visible chat but preserves internal scheduler access', async () => {
    const diaryTool = await tool({
      name: 'lumi_diary_read_day',
      description: 'Read a private diary day.',
      parameters: z.object({}),
      execute: async () => 'private diary',
    })
    const publicTool = await tool({
      name: 'lumi_memory_search',
      description: 'Search policy-filtered memory.',
      parameters: z.object({}),
      execute: async () => 'shared memory',
    })
    const interaction = {
      conversationId: 'direct-moussy',
      conversationType: 'direct' as const,
      actorId: 'moussy',
      participantIds: ['moussy'],
    }

    const visible = bindLumiToolMeshToolsForTurn([diaryTool, publicTool], interaction)
    const internal = bindLumiToolMeshToolsForTurn([diaryTool, publicTool], interaction, { allowPrivateLumiTools: true })

    expect(visible.map(tool => tool.function.name)).toEqual(['lumi_memory_search'])
    expect(internal.map(tool => tool.function.name)).toEqual(['lumi_diary_read_day', 'lumi_memory_search'])
  })
})
