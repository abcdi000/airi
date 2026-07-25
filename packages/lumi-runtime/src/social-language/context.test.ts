import { describe, expect, it } from 'vitest'

import {
  projectLumiReplyerContext,
  selectLumiAdaptiveContextBudget,
} from './context'

describe('lumi social-language stage context', () => {
  it('uses a bounded dynamic Planner window below the provider maximum for long histories', () => {
    /**
     * @example
     * A 142k-token conversation uses a compact active Planner window while the
     * persisted timeline and provider ceiling remain at one million tokens.
     */
    const budget = selectLumiAdaptiveContextBudget({
      providerMaxContextTokens: 1_000_000,
      estimatedHistoryTokens: 142_000,
      outputReserveTokens: 64_000,
      promptReserveTokens: 32_000,
      toolCount: 24,
    })

    expect(budget.plannerContextWindowTokens).toBeLessThan(1_000_000)
    expect(budget.plannerContextWindowTokens).toBeGreaterThan(96_000)
    expect(budget.replyerHistoryTokens).toBeLessThan(budget.plannerHistoryTokens)
  })

  it('keeps the model-authored continuity summary and newest verbatim turns for Replyer', () => {
    /**
     * @example
     * Planner saw the full active projection. Replyer receives its semantic
     * intent, the durable summary, and the newest wording context.
     */
    const projected = projectLumiReplyerContext({
      history: [
        { role: 'system', content: 'planner-only system prompt' },
        { role: 'system', content: '[Lumi conversation continuity summary]\nOlder promise and unresolved question.' },
        ...Array.from({ length: 20 }, (_, index) => ({
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `turn-${index}-${'x'.repeat(240)}`,
        })),
      ],
      maxHistoryTokens: 700,
    })

    expect(projected.continuitySummary).toContain('Older promise and unresolved question')
    expect(projected.history.at(-1)?.content).toContain('turn-19')
    expect(projected.history.some(message => message.content.includes('turn-0'))).toBe(false)
    expect(projected.history.every(message => message.role !== 'system')).toBe(true)
    expect(projected.omittedMessageCount).toBeGreaterThan(0)
  })
})
