import type { LumiIdentitySnapshot } from './lumi-identity'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  LUMI_DOGGY_USER_ID,
  LUMI_MOUSSY_USER_ID,

  useLumiIdentityStore,
} from './lumi-identity'

function snapshot(activeUserId = LUMI_DOGGY_USER_ID): LumiIdentitySnapshot {
  const now = '2026-07-21T00:00:00.000Z'
  return {
    users: [
      { id: LUMI_DOGGY_USER_ID, displayName: 'Doggy', preferredAddress: 'Doggy', role: 'owner', status: 'active', createdAt: now, updatedAt: now },
      { id: LUMI_MOUSSY_USER_ID, displayName: 'Moussy', preferredAddress: 'Moussy', role: 'member', status: 'active', createdAt: now, updatedAt: now },
    ],
    externalIdentities: [],
    activeUserId,
    migrationVersion: 'multi-user-v1',
  }
}

describe('lumi identity switching', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('rejects a switch while a response or scoped task is active', async () => {
    const store = useLumiIdentityStore()
    const setActiveUser = vi.fn(async ({ userId }: { userId: string }) => snapshot(userId))
    store.setBridge({
      getSnapshot: async () => snapshot(),
      createUser: async () => snapshot(),
      updateUser: async () => snapshot(),
      setActiveUser,
      linkExternalIdentity: async () => snapshot(),
      replaceSnapshot: async value => value,
    })
    store.setSwitchPolicy({ canSwitch: () => false, afterSwitch: async () => {} })
    await store.initialize()

    await expect(store.selectUser(LUMI_MOUSSY_USER_ID)).rejects.toThrow('Lumi is busy')
    expect(setActiveUser).not.toHaveBeenCalled()
    expect(store.activeUserId).toBe(LUMI_DOGGY_USER_ID)
  })

  it('waits for scoped stores to reload before completing a switch', async () => {
    const store = useLumiIdentityStore()
    let finishReload = () => {}
    const reload = new Promise<void>((resolve) => {
      finishReload = resolve
    })
    const afterSwitch = vi.fn(async () => reload)
    store.setBridge({
      getSnapshot: async () => snapshot(),
      createUser: async () => snapshot(),
      updateUser: async () => snapshot(),
      setActiveUser: async ({ userId }) => snapshot(userId),
      linkExternalIdentity: async () => snapshot(),
      replaceSnapshot: async value => value,
    })
    store.setSwitchPolicy({ canSwitch: () => true, afterSwitch })
    await store.initialize()

    const pending = store.selectUser(LUMI_MOUSSY_USER_ID)
    await Promise.resolve()
    expect(store.switching).toBe(true)
    finishReload()
    await pending

    expect(afterSwitch).toHaveBeenCalledWith(LUMI_MOUSSY_USER_ID, 1)
    expect(store.activeUserId).toBe(LUMI_MOUSSY_USER_ID)
    expect(store.switching).toBe(false)
  })

  it('reloads scoped stores when another desktop window changes the active user', async () => {
    const store = useLumiIdentityStore()
    const afterSwitch = vi.fn(async () => {})
    store.setBridge({
      getSnapshot: async () => snapshot(),
      createUser: async () => snapshot(),
      updateUser: async () => snapshot(),
      setActiveUser: async ({ userId }) => snapshot(userId),
      linkExternalIdentity: async () => snapshot(),
      replaceSnapshot: async value => value,
    })
    store.setSwitchPolicy({ canSwitch: () => true, afterSwitch })
    await store.initialize()

    await store.synchronizeSnapshot(snapshot(LUMI_MOUSSY_USER_ID))

    expect(store.activeUserId).toBe(LUMI_MOUSSY_USER_ID)
    expect(afterSwitch).toHaveBeenCalledWith(LUMI_MOUSSY_USER_ID, 1)
    expect(store.switching).toBe(false)
  })

  it('restores the desktop identity after an operator-scoped archive operation', async () => {
    const store = useLumiIdentityStore()
    const afterSwitch = vi.fn(async () => {})
    store.setBridge({
      getSnapshot: async () => snapshot(),
      createUser: async () => snapshot(),
      updateUser: async () => snapshot(),
      setActiveUser: async ({ userId }) => snapshot(userId),
      linkExternalIdentity: async () => snapshot(),
      replaceSnapshot: async value => value,
    })
    store.setSwitchPolicy({ canSwitch: () => true, afterSwitch })
    await store.initialize()

    const scopedUserId = await store.withUserScope(LUMI_MOUSSY_USER_ID, async () => store.activeUserId)

    expect(scopedUserId).toBe(LUMI_MOUSSY_USER_ID)
    expect(store.activeUserId).toBe(LUMI_DOGGY_USER_ID)
    expect(store.switching).toBe(false)
    expect(afterSwitch).toHaveBeenNthCalledWith(1, LUMI_MOUSSY_USER_ID, 1)
    expect(afterSwitch).toHaveBeenNthCalledWith(2, LUMI_DOGGY_USER_ID, 2)
  })

  it('resolves only exact external identity mappings owned by active users', async () => {
    const store = useLumiIdentityStore()
    const mapped = snapshot()
    mapped.externalIdentities = [{
      id: 'external-moussy-lan',
      userId: LUMI_MOUSSY_USER_ID,
      provider: 'lumi-lan',
      providerInstanceId: 'doggy-desktop',
      externalUserId: 'moussy-phone',
      createdAt: '2026-07-21T00:00:00.000Z',
    }]
    store.setBridge({
      getSnapshot: async () => mapped,
      createUser: async () => mapped,
      updateUser: async () => mapped,
      setActiveUser: async () => mapped,
      linkExternalIdentity: async () => mapped,
      replaceSnapshot: async value => value,
    })
    await store.initialize()

    expect(store.resolveExternalIdentity({
      provider: ' lumi-lan ',
      providerInstanceId: 'doggy-desktop',
      externalUserId: 'moussy-phone',
    })?.id).toBe(LUMI_MOUSSY_USER_ID)
    expect(store.resolveExternalIdentity({
      provider: 'lumi-lan',
      providerInstanceId: 'doggy-desktop',
      externalUserId: 'unknown-phone',
    })).toBeUndefined()

    mapped.users[1] = { ...mapped.users[1]!, status: 'inactive' }
    await store.synchronizeSnapshot(mapped)
    expect(store.resolveExternalIdentity({
      provider: 'lumi-lan',
      providerInstanceId: 'doggy-desktop',
      externalUserId: 'moussy-phone',
    })).toBeUndefined()
  })
})
