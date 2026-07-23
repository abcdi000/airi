import { describe, expect, it, vi } from 'vitest'

import { createMcpResourceLeaseRegistry } from './resource-leases'

function leaseInput(id = 'lease-1') {
  return {
    id,
    resource: 'browser' as const,
    toolName: 'playwright::browser_navigate',
    serverName: 'playwright',
    actorId: 'moussy',
    conversationId: 'room-doggy-moussy',
    deviceId: 'lumi-device-1',
  }
}

describe('mcp resource lease registry', () => {
  /** @example registry.begin(leaseInput(), terminate) */
  it('lists content-free ownership metadata and removes the lease only after completion', () => {
    const registry = createMcpResourceLeaseRegistry()
    registry.begin(leaseInput(), vi.fn())

    expect(registry.list()).toMatchObject([leaseInput()])
    expect(registry.list()[0]?.terminationRequestedAt).toBeNull()

    registry.finish('lease-1')
    expect(registry.list()).toEqual([])
  })

  /** @example await registry.terminate('lease-1') */
  it('requests one real session termination without pretending the lease has finished', async () => {
    const registry = createMcpResourceLeaseRegistry()
    const terminate = vi.fn().mockResolvedValue(undefined)
    registry.begin(leaseInput(), terminate)

    await registry.terminate('lease-1')
    await registry.terminate('lease-1')

    expect(terminate).toHaveBeenCalledTimes(1)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.terminationRequestedAt).toBeTruthy()
  })

  /** @example await registry.terminate('lease-1') */
  it('restores the active state when underlying session termination fails', async () => {
    const registry = createMcpResourceLeaseRegistry()
    registry.begin(leaseInput(), vi.fn().mockRejectedValue(new Error('close failed')))

    await expect(registry.terminate('lease-1')).rejects.toThrow('close failed')
    expect(registry.list()[0]?.terminationRequestedAt).toBeNull()
  })
})
