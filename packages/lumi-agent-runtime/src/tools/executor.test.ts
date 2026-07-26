import type { ToolSpec } from './registry'

import { describe, expect, it, vi } from 'vitest'

import {
  executeToolPlan,
  ToolPlanValidationError,
} from './executor'
import { ToolRegistry } from './registry'

function spec(name: string, handler: ToolSpec['handler']): ToolSpec {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    provider: 'test',
    visibility: 'visible',
    stage: 'planner',
    chatScope: 'direct',
    riskLevel: 'low',
    executionMode: 'automatic',
    sideEffectType: 'read',
    idempotencyPolicy: 'none',
    requiredScopes: [],
    handler,
  }
}

const context = {
  conversationId: 'direct-doggy',
  personId: 'doggy',
  grantedScopes: new Set<string>(),
  runtimeMode: 'maisaka' as const,
}

describe('executeToolPlan', () => {
  it('runs independent steps concurrently', async () => {
    const registry = new ToolRegistry()
    let running = 0
    let maxRunning = 0
    const handler = vi.fn(async () => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      await new Promise(resolve => setTimeout(resolve, 20))
      running -= 1
      return { success: true }
    })
    registry.register(spec('one', handler))
    registry.register(spec('two', handler))

    const result = await executeToolPlan(registry, [
      { id: 'a', toolName: 'one', arguments: {} },
      { id: 'b', toolName: 'two', arguments: {} },
    ], context)

    expect(result.success).toBe(true)
    expect(maxRunning).toBe(2)
  })

  it('waits for dependencies before starting the next topology layer', async () => {
    const registry = new ToolRegistry()
    const order: string[] = []
    registry.register(spec('first', async () => {
      order.push('first')
      return { success: true }
    }))
    registry.register(spec('second', async () => {
      order.push('second')
      return { success: true }
    }))

    await executeToolPlan(registry, [
      { id: 'a', toolName: 'first', arguments: {} },
      { id: 'b', toolName: 'second', arguments: {}, dependsOn: ['a'] },
    ], context)

    expect(order).toEqual(['first', 'second'])
  })

  it('rejects cyclic dependencies before executing any tool', async () => {
    const registry = new ToolRegistry()
    const handler = vi.fn(async () => ({ success: true }))
    registry.register(spec('tool', handler))

    await expect(executeToolPlan(registry, [
      { id: 'a', toolName: 'tool', arguments: {}, dependsOn: ['b'] },
      { id: 'b', toolName: 'tool', arguments: {}, dependsOn: ['a'] },
    ], context)).rejects.toBeInstanceOf(ToolPlanValidationError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('allows dependents to continue after an optional dependency fails', async () => {
    const registry = new ToolRegistry()
    registry.register(spec('optional-failure', async () => ({
      success: false,
      errorCode: 'EXPECTED',
      errorMessage: 'optional failure',
    })))
    const dependent = vi.fn(async () => ({ success: true }))
    registry.register(spec('dependent', dependent))

    const result = await executeToolPlan(registry, [
      { id: 'a', toolName: 'optional-failure', arguments: {}, optional: true },
      { id: 'b', toolName: 'dependent', arguments: {}, dependsOn: ['a'] },
    ], context)

    expect(dependent).toHaveBeenCalledOnce()
    expect(result.success).toBe(true)
  })
})
