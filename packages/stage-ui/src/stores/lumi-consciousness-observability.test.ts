// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useLumiConsciousnessObservabilityStore } from './lumi-consciousness-observability'

describe('lumi consciousness observability', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('distinguishes unavailable cache accounting from a measured zero hit', () => {
    const store = useLumiConsciousnessObservabilityStore()
    store.begin({
      id: 'request-1',
      purpose: 'planner',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      conversationId: 'direct-doggy',
      messages: [{ role: 'user', content: 'hello' }],
    })

    store.recordUsage('request-1', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
    })

    expect(store.requests[0]?.cacheAccounting).toBe('unavailable')
    expect(store.requests[0]?.promptCacheHitTokens).toBeUndefined()
    expect(store.requests[0]?.promptCacheMissTokens).toBeUndefined()

    store.recordUsage('request-1', {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_cache_hit_tokens: 60,
      prompt_cache_miss_tokens: 40,
    })

    expect(store.requests[0]?.cacheAccounting).toBe('measured')
    expect(store.requests[0]?.promptCacheHitTokens).toBe(60)
    expect(store.requests[0]?.promptCacheMissTokens).toBe(40)
  })

  it('finds the best message prefix across Planner and Replyer requests', () => {
    const store = useLumiConsciousnessObservabilityStore()
    store.begin({
      id: 'planner-1',
      purpose: 'planner',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      conversationId: 'direct-doggy',
      messages: [
        { role: 'system', content: 'stable persona' },
        { role: 'user', content: 'hello' },
        { role: 'user', content: '[Lumi trusted Planner task]\nplan' },
      ],
    })
    store.complete('planner-1')

    store.begin({
      id: 'replyer-1',
      purpose: 'replyer',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      conversationId: 'direct-doggy',
      messages: [
        { role: 'system', content: 'stable persona' },
        { role: 'user', content: 'hello' },
        { role: 'user', content: '[Lumi trusted Replyer contract]\nword it' },
      ],
    })

    const diagnostics = store.requests.find(request => request.id === 'replyer-1')?.prefixDiagnostics
    expect(diagnostics?.comparedRequestId).toBe('planner-1')
    expect(diagnostics?.comparedPurpose).toBe('planner')
    expect(diagnostics?.commonMessageCount).toBe(2)
    expect(diagnostics?.firstDivergenceMessageIndex).toBe(2)
    expect(diagnostics?.estimatedCommonPrefixTokens).toBeGreaterThan(0)
  })

  it('persists protocol metadata and failures without storing private prompts', () => {
    const store = useLumiConsciousnessObservabilityStore()
    store.begin({
      id: 'planner-error',
      purpose: 'planner',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      conversationId: 'direct-doggy',
      toolCount: 18,
      requestedToolChoice: 'required',
      effectiveToolChoice: 'omitted',
      thinkingMode: 'provider-default',
    })
    store.fail('planner-error', 'Thinking mode does not support this tool_choice')

    const trace = store.requests.find(request => request.id === 'planner-error')
    expect(trace?.requestMessages).toBeUndefined()
    expect(trace?.toolCount).toBe(18)
    expect(trace?.requestedToolChoice).toBe('required')
    expect(trace?.effectiveToolChoice).toBe('omitted')
    expect(trace?.thinkingMode).toBe('provider-default')
    expect(trace?.status).toBe('error')
    expect(trace?.error).toContain('tool_choice')
  })

  it('does not let a stale chat window restore traces after the settings window clears them', () => {
    // ROOT CAUSE:
    //
    // Each Electron BrowserWindow owns a separate Pinia instance. Clearing the
    // settings store previously left the chat window's in-memory request list
    // intact, and the next streamed delta persisted that stale list again.
    //
    // The persisted clear marker now invalidates traces in every store before
    // they can be updated or written.
    const chatStore = useLumiConsciousnessObservabilityStore()
    chatStore.begin({
      id: 'old-request',
      purpose: 'replyer',
      model: 'deepseek-v4-flash',
      startedAt: Date.now() - 1_000,
      messages: [{ role: 'user', content: 'old private prompt' }],
    })

    setActivePinia(createPinia())
    const settingsStore = useLumiConsciousnessObservabilityStore()
    expect(settingsStore.requests).toHaveLength(1)
    settingsStore.clear()

    chatStore.appendDelta('old-request', 'late streamed output')

    setActivePinia(createPinia())
    const reopenedSettingsStore = useLumiConsciousnessObservabilityStore()
    expect(reopenedSettingsStore.requests).toHaveLength(0)
    expect(localStorage.getItem('runtime/lumi/consciousness-request-log-v1')).toBe('[]')
  })

  it('keeps only the latest bounded request history', () => {
    const store = useLumiConsciousnessObservabilityStore()
    for (let index = 0; index < 75; index += 1) {
      store.begin({
        id: `request-${index}`,
        purpose: 'planner',
        model: 'deepseek-v4-flash',
        startedAt: Date.now() + index,
      })
    }

    expect(store.requests).toHaveLength(60)
    expect(store.requests[0]?.id).toBe('request-15')
    expect(store.requests.at(-1)?.id).toBe('request-74')
  })

  it('keeps full prompts for enough requests to inspect one complete agent turn', () => {
    // ROOT CAUSE:
    //
    // One visible chat turn can immediately produce Planner, Replyer,
    // expression, feedback, relationship, and memory requests. Retaining only
    // four full traces removed the Planner input before the user could inspect
    // the just-completed turn.
    //
    // The latest twelve requests now retain their complete local prompt while
    // older traces keep only timing and token statistics.
    const store = useLumiConsciousnessObservabilityStore()
    for (let index = 0; index < 13; index += 1) {
      store.begin({
        id: `turn-request-${index}`,
        purpose: index === 0 ? 'planner' : 'other',
        model: 'deepseek-v4-flash',
        startedAt: Date.now() + index,
        messages: [{ role: 'user', content: `prompt-${index}` }],
      })
      store.complete(`turn-request-${index}`)
    }

    expect(store.requests[0]?.requestMessages).toBeUndefined()
    expect(store.requests[1]?.requestMessages?.[0]?.content).toBe('prompt-1')
    expect(store.requests.at(-1)?.requestMessages?.[0]?.content).toBe('prompt-12')
  })
})
