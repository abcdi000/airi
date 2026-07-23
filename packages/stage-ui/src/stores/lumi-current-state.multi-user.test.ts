import type { LumiCurrentStatePersistenceBridge, LumiCurrentStatePersistenceSnapshot } from './lumi-current-state'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLumiCurrentStateStore } from './lumi-current-state'
import { LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID } from './lumi-identity'

describe('lumi-current-state multi-user isolation', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    })
    setActivePinia(createPinia())
  })

  it('persists concurrent Doggy and Moussy state updates independently', async () => {
    const snapshots = new Map<string, LumiCurrentStatePersistenceSnapshot>([
      [LUMI_DOGGY_USER_ID, { state: null }],
      [LUMI_MOUSSY_USER_ID, { state: null }],
    ])
    const bridge: LumiCurrentStatePersistenceBridge = {
      loadCurrentStateFromDatabase: vi.fn(async userId => snapshots.get(userId ?? '') ?? { state: null }),
      saveCurrentState: vi.fn(async (snapshot, userId) => {
        expect(userId).toBeTruthy()
        snapshots.set(userId!, snapshot)
        return snapshot
      }),
      clearCurrentState: vi.fn(async () => {}),
    }
    const store = useLumiCurrentStateStore()
    store.setActiveStateUser('settings-preview-user')
    store.setPersistenceBridge(bridge)
    await Promise.all([
      store.ensureUserStateLoaded(LUMI_DOGGY_USER_ID),
      store.ensureUserStateLoaded(LUMI_MOUSSY_USER_ID),
    ])

    await Promise.all([
      store.saveCurrentState({
        recentTopics: ['Lumi desktop host'],
        activeProjects: ['LAN host protocol'],
        lastContinuationPoint: 'Continue host-authoritative scheduling',
        turnCount: 8,
      }, LUMI_DOGGY_USER_ID),
      store.saveCurrentState({
        recentTopics: ['Cooperative game'],
        activeProjects: ['Weekend game session'],
        lastContinuationPoint: 'Choose the next game together',
        turnCount: 3,
      }, LUMI_MOUSSY_USER_ID),
    ])

    const doggyContext = store.buildPromptContext(LUMI_DOGGY_USER_ID)
    const moussyContext = store.buildPromptContext(LUMI_MOUSSY_USER_ID)
    expect(doggyContext).toContain('Lumi desktop host')
    expect(doggyContext).not.toContain('Cooperative game')
    expect(moussyContext).toContain('Cooperative game')
    expect(moussyContext).not.toContain('Lumi desktop host')
    expect(snapshots.get(LUMI_DOGGY_USER_ID)?.state?.turnCount).toBe(8)
    expect(snapshots.get(LUMI_MOUSSY_USER_ID)?.state?.turnCount).toBe(3)
  })
})
