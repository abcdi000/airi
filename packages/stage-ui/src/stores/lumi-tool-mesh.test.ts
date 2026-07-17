import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LumiToolDefinition } from './lumi-tool-mesh'
import {
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
})
