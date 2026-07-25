import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useLumiConsciousnessObservabilityStore } from './lumi-consciousness-observability'

describe('lumi consciousness observability', () => {
  beforeEach(() => {
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
})
