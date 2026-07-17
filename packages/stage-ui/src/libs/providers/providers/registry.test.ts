import { describe, expect, it } from 'vitest'

import './index'

import { listProviders } from './registry'

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
