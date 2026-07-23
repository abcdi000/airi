import { randomUUID } from 'node:crypto'

export type LumiServerExclusiveResource = 'browser' | 'computer-use' | 'minecraft' | 'vector-python'

export interface LumiServerResourceLease {
  id: string
  resource: LumiServerExclusiveResource
  toolName: string
  actorPersonId: string
  conversationId: string
  startedAt: number
  terminationRequestedAt?: number
}

/** Serializes exclusive host resources and exposes content-free active leases. */
export class LumiServerResourceRegistry {
  private readonly tails = new Map<LumiServerExclusiveResource, Promise<void>>()
  private readonly active = new Map<string, { snapshot: LumiServerResourceLease, controller: AbortController }>()

  run<TResult>(
    resource: LumiServerExclusiveResource,
    owner: Pick<LumiServerResourceLease, 'toolName' | 'actorPersonId' | 'conversationId'>,
    operation: (signal: AbortSignal) => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.tails.get(resource) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(async () => {
      const controller = new AbortController()
      const snapshot: LumiServerResourceLease = {
        id: `lumi-resource-${randomUUID()}`,
        resource,
        ...owner,
        startedAt: Date.now(),
      }
      this.active.set(snapshot.id, { snapshot, controller })
      try {
        return await operation(controller.signal)
      }
      finally {
        this.active.delete(snapshot.id)
      }
    })
    const tail = result.then(() => {}, () => {})
    this.tails.set(resource, tail)
    void tail.finally(() => {
      if (this.tails.get(resource) === tail)
        this.tails.delete(resource)
    })
    return result
  }

  list(): LumiServerResourceLease[] {
    return [...this.active.values()]
      .map(entry => structuredClone(entry.snapshot))
      .sort((left, right) => right.startedAt - left.startedAt)
  }

  terminate(leaseId: string): LumiServerResourceLease {
    const entry = this.active.get(leaseId)
    if (!entry)
      throw new Error('Resource lease is no longer active')
    if (!entry.snapshot.terminationRequestedAt) {
      entry.snapshot.terminationRequestedAt = Date.now()
      entry.controller.abort(new Error('Resource lease terminated by server owner'))
    }
    return structuredClone(entry.snapshot)
  }

  async shutdown(): Promise<void> {
    for (const entry of this.active.values()) {
      entry.snapshot.terminationRequestedAt ??= Date.now()
      entry.controller.abort(new Error('Lumi Server is shutting down'))
    }
    while (this.tails.size > 0)
      await Promise.all([...this.tails.values()])
  }
}

/** Classifies one qualified MCP name into its single host resource. */
export function classifyMcpResource(name: string): LumiServerExclusiveResource | undefined {
  const normalized = name.toLowerCase()
  if (normalized.includes('computer_use') || normalized.includes('computer-use') || normalized.includes('desktop_'))
    return 'computer-use'
  if (normalized.includes('minecraft'))
    return 'minecraft'
  if (normalized.includes('playwright') || normalized.includes('browser_'))
    return 'browser'
  return undefined
}
