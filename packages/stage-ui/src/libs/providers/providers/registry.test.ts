import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { listProviders } from './registry'

import './index'

function getSchemaShape(schema: unknown): Record<string, unknown> {
  const candidate = schema as {
    shape?: Record<string, unknown>
    _def?: {
      shape?: Record<string, unknown> | (() => Record<string, unknown>)
    }
  }

  if (candidate.shape)
    return candidate.shape
  if (typeof candidate._def?.shape === 'function')
    return candidate._def.shape()
  return candidate._def?.shape ?? {}
}

describe('provider registry chat defaults', () => {
  it('registers Sub2API for the offline client settings', () => {
    const provider = listProviders().find(candidate => candidate.id === 'sub2api')

    expect(provider).toBeDefined()
    expect(provider?.tasks).toContain('chat')

    const schema = provider!.createProviderConfig({ t: input => input })
    const parsed = z.parse(schema, { apiKey: 'test-key' }) as Record<string, unknown>

    expect(parsed.baseUrl).toBe('http://127.0.0.1:8080/v1/')
    expect(parsed.protocol).toBe('auto')
    expect(parsed.reasoningEffort).toBe('auto')
    expect(parsed.maxToolSteps).toBe(64)
  })

  it('adds maxToolSteps to every chat provider config', () => {
    const providers = listProviders().filter(provider => provider.tasks.includes('chat'))

    expect(providers.length).toBeGreaterThan(0)

    for (const provider of providers) {
      const schema = provider.createProviderConfig({ t: input => input })
      const shape = getSchemaShape(schema)

      expect(shape, provider.id).toHaveProperty('maxToolSteps')
    }
  })
})
