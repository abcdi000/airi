import type { ElectronMcpResourceLease, ElectronMcpResourceLeaseInput } from '../../../../shared/eventa'

interface ActiveMcpResourceLease {
  snapshot: ElectronMcpResourceLease
  terminate: () => Promise<void>
}

/**
 * Tracks model-facing MCP calls that own one exclusive host resource.
 *
 * Use when:
 * - The desktop host must expose active browser, Minecraft, or Computer Use work
 * - An operator needs to terminate a stuck MCP session without releasing a fake logical lock
 *
 * Expects:
 * - Callers finish every lease after the underlying MCP request settles
 * - The terminate callback stops the underlying MCP session before it resolves
 *
 * Returns:
 * - An in-memory registry whose snapshots never contain tool arguments or chat content
 */
export function createMcpResourceLeaseRegistry() {
  const active = new Map<string, ActiveMcpResourceLease>()

  function begin(input: ElectronMcpResourceLeaseInput, terminate: () => Promise<void>) {
    if (active.has(input.id))
      throw new Error(`MCP resource lease already exists: ${input.id}`)

    const snapshot: ElectronMcpResourceLease = {
      ...input,
      startedAt: new Date().toISOString(),
      terminationRequestedAt: null,
    }
    active.set(input.id, { snapshot, terminate })
    return structuredClone(snapshot)
  }

  function finish(leaseId: string) {
    active.delete(leaseId)
  }

  function list() {
    return [...active.values()]
      .map(entry => structuredClone(entry.snapshot))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  }

  async function terminate(leaseId: string) {
    const entry = active.get(leaseId)
    if (!entry)
      throw new Error('MCP resource lease is no longer active.')
    if (entry.snapshot.terminationRequestedAt)
      return structuredClone(entry.snapshot)

    entry.snapshot.terminationRequestedAt = new Date().toISOString()
    try {
      await entry.terminate()
    }
    catch (error) {
      entry.snapshot.terminationRequestedAt = null
      throw error
    }
    return structuredClone(entry.snapshot)
  }

  return {
    begin,
    finish,
    list,
    terminate,
  }
}
