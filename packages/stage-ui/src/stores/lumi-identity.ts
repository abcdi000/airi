import { errorMessageFrom } from '@moeru/std'
import { defineStore } from 'pinia'
import { computed, readonly, ref, shallowRef } from 'vue'

export const LUMI_DOGGY_USER_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
export const LUMI_MOUSSY_USER_ID = 'lumi-user-00000000-0000-4000-8000-000000000002'

export type LumiUserRole = 'owner' | 'member' | 'guest'
export type LumiUserStatus = 'active' | 'inactive'

/** A person known by Lumi, independent of any channel or account identity. */
export interface LumiUserRecord {
  id: string
  displayName: string
  preferredAddress: string
  role: LumiUserRole
  status: LumiUserStatus
  createdAt: string
  updatedAt: string
}

/** A provider account that resolves to one internal Lumi user. */
export interface LumiExternalIdentityRecord {
  id: string
  userId: string
  provider: string
  providerInstanceId: string
  externalUserId: string
  createdAt: string
}

export interface LumiIdentitySnapshot {
  users: LumiUserRecord[]
  externalIdentities: LumiExternalIdentityRecord[]
  activeUserId: string
  migrationVersion: string
  dbPath?: string
}

export interface LumiIdentityBridge {
  getSnapshot: () => Promise<LumiIdentitySnapshot>
  createUser: (input: { displayName: string, preferredAddress?: string }) => Promise<LumiIdentitySnapshot>
  updateUser: (input: { id: string, displayName?: string, preferredAddress?: string, status?: LumiUserStatus }) => Promise<LumiIdentitySnapshot>
  setActiveUser: (input: { userId: string }) => Promise<LumiIdentitySnapshot>
  linkExternalIdentity: (input: Omit<LumiExternalIdentityRecord, 'id' | 'createdAt'>) => Promise<LumiIdentitySnapshot>
  replaceSnapshot: (snapshot: LumiIdentitySnapshot) => Promise<LumiIdentitySnapshot>
}

/** Request-scoped identity passed to Lumi domain operations and future channel adapters. */
export interface LumiInteractionIdentity {
  userId: string
  personaId: string
  conversationId?: string
  actorUserId?: string
  provider?: string
  providerInstanceId?: string
  externalUserId?: string
}

export interface LumiExternalIdentityClaim {
  provider: string
  providerInstanceId: string
  externalUserId: string
}

export const useLumiIdentityStore = defineStore('lumi-identity', () => {
  const users = ref<LumiUserRecord[]>([])
  const externalIdentities = ref<LumiExternalIdentityRecord[]>([])
  const activeUserId = shallowRef('')
  const migrationVersion = shallowRef('')
  const dbPath = shallowRef('')
  const ready = shallowRef(false)
  const switching = shallowRef(false)
  const switchEpoch = shallowRef(0)
  const lastError = shallowRef('')
  const bridge = shallowRef<LumiIdentityBridge | null>(null)
  const canSwitch = shallowRef<() => boolean>(() => true)
  const afterSwitch = shallowRef<(userId: string, epoch: number) => Promise<void>>(async () => {})
  let initializePromise: Promise<void> | null = null

  const activeUser = computed(() => users.value.find(user => user.id === activeUserId.value))
  const activeUsers = computed(() => users.value.filter(user => user.status === 'active'))

  function setBridge(nextBridge: LumiIdentityBridge | null) {
    bridge.value = nextBridge
  }

  function setSwitchPolicy(policy: {
    canSwitch: () => boolean
    afterSwitch: (userId: string, epoch: number) => Promise<void>
  }) {
    canSwitch.value = policy.canSwitch
    afterSwitch.value = policy.afterSwitch
  }

  function applySnapshot(snapshot: LumiIdentitySnapshot) {
    users.value = snapshot.users
    externalIdentities.value = snapshot.externalIdentities
    activeUserId.value = snapshot.activeUserId
    migrationVersion.value = snapshot.migrationVersion
    dbPath.value = snapshot.dbPath ?? ''
  }

  async function initialize() {
    if (initializePromise)
      return initializePromise
    initializePromise = (async () => {
      if (!bridge.value)
        throw new Error('Lumi identity persistence bridge is unavailable')
      applySnapshot(await bridge.value.getSnapshot())
      ready.value = true
      lastError.value = ''
    })().catch((error) => {
      lastError.value = errorMessageFrom(error) ?? String(error)
      initializePromise = null
      throw error
    })
    return initializePromise
  }

  async function createUser(input: { displayName: string, preferredAddress?: string }) {
    if (!bridge.value)
      throw new Error('Lumi identity persistence bridge is unavailable')
    applySnapshot(await bridge.value.createUser(input))
  }

  async function updateUser(input: { id: string, displayName?: string, preferredAddress?: string, status?: LumiUserStatus }) {
    if (!bridge.value)
      throw new Error('Lumi identity persistence bridge is unavailable')
    applySnapshot(await bridge.value.updateUser(input))
  }

  /** Resolves a channel-owned account to one active host-owned Lumi user. */
  function resolveExternalIdentity(claim: LumiExternalIdentityClaim) {
    const provider = normalizeExternalIdentityPart(claim.provider)
    const providerInstanceId = normalizeExternalIdentityPart(claim.providerInstanceId)
    const externalUserId = normalizeExternalIdentityPart(claim.externalUserId)
    if (!provider || !providerInstanceId || !externalUserId)
      return undefined

    const mapping = externalIdentities.value.find(identity =>
      identity.provider === provider
      && identity.providerInstanceId === providerInstanceId
      && identity.externalUserId === externalUserId,
    )
    if (!mapping)
      return undefined
    return users.value.find(user => user.id === mapping.userId && user.status === 'active')
  }

  async function importSnapshot(snapshot: LumiIdentitySnapshot) {
    if (!bridge.value)
      throw new Error('Lumi identity persistence bridge is unavailable')
    applySnapshot(await bridge.value.replaceSnapshot(snapshot))
    switchEpoch.value += 1
    await afterSwitch.value(activeUserId.value, switchEpoch.value)
  }

  /** Applies an authoritative identity snapshot broadcast by another desktop window. */
  async function synchronizeSnapshot(snapshot: LumiIdentitySnapshot) {
    const previousUserId = activeUserId.value
    if (switching.value) {
      return
    }

    if (!ready.value || previousUserId === snapshot.activeUserId) {
      applySnapshot(snapshot)
      return
    }

    switching.value = true
    try {
      // Mark the renderer as switching before changing the reactive user ID so
      // scoped-store watchers cannot start a second, overlapping reload.
      applySnapshot(snapshot)
      switchEpoch.value += 1
      await afterSwitch.value(snapshot.activeUserId, switchEpoch.value)
      lastError.value = ''
    }
    catch (error) {
      lastError.value = errorMessageFrom(error) ?? String(error)
      throw error
    }
    finally {
      switching.value = false
    }
  }

  /** Runs an operator-only archive action under an explicit user scope. */
  async function withUserScope<TResult>(userId: string, operation: () => Promise<TResult>) {
    if (switching.value || !canSwitch.value())
      throw new Error('Lumi is busy. Device archive operations require an idle runtime.')
    if (!users.value.some(user => user.id === userId))
      throw new Error('Lumi archive user was not found')

    const previousUserId = activeUserId.value
    switching.value = true
    try {
      activeUserId.value = userId
      switchEpoch.value += 1
      await afterSwitch.value(userId, switchEpoch.value)
      return await operation()
    }
    finally {
      activeUserId.value = previousUserId
      switchEpoch.value += 1
      try {
        await afterSwitch.value(previousUserId, switchEpoch.value)
      }
      finally {
        switching.value = false
      }
    }
  }

  /**
   * Selects the desktop interaction user after the caller has stopped active work.
   *
   * Use when:
   * - The development identity picker changes the person speaking with Lumi
   *
   * Expects:
   * - Chat generation and user-scoped background writes are idle
   *
   * Returns:
   * - The new epoch used by scoped stores to reject stale asynchronous work
   */
  async function selectUser(userId: string) {
    if (!bridge.value)
      throw new Error('Lumi identity persistence bridge is unavailable')
    if (switching.value || userId === activeUserId.value)
      return switchEpoch.value
    if (!canSwitch.value())
      throw new Error('Lumi is busy. Wait for the current response or task to finish before switching users.')
    if (!users.value.some(user => user.id === userId && user.status === 'active'))
      throw new Error('Lumi user is unavailable')

    switching.value = true
    try {
      const snapshot = await bridge.value.setActiveUser({ userId })
      switchEpoch.value += 1
      applySnapshot(snapshot)
      await afterSwitch.value(userId, switchEpoch.value)
      lastError.value = ''
      return switchEpoch.value
    }
    catch (error) {
      lastError.value = errorMessageFrom(error) ?? String(error)
      throw error
    }
    finally {
      switching.value = false
    }
  }

  return {
    users: readonly(users),
    externalIdentities: readonly(externalIdentities),
    activeUserId,
    activeUser,
    activeUsers,
    migrationVersion,
    dbPath,
    ready,
    switching,
    switchEpoch,
    lastError,
    setBridge,
    setSwitchPolicy,
    initialize,
    createUser,
    updateUser,
    resolveExternalIdentity,
    importSnapshot,
    synchronizeSnapshot,
    withUserScope,
    selectUser,
  }
})

function normalizeExternalIdentityPart(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : ''
}
