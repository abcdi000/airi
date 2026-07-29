import type { LumiCurrentStatePersistenceBridge, LumiCurrentStatePersistenceSnapshot } from './lumi-current-state'

import { createLumiWorkingMemory } from '@proj-airi/lumi-runtime'
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

  // ROOT CAUSE:
  //
  // The legacy current_state store keyed data by user only. Concurrent
  // conversations could therefore share one mutable short-state document,
  // while model/tool writes could overwrite the host-owned cognitive fast loop.
  //
  // The compatibility store must project exact actor/conversation working
  // memory and become read-only whenever the cognitive bridge is active.
  /** @example Direct projections stay conversation-scoped and group rooms inherit no private state. */
  it('projects authoritative working memory without allowing legacy overwrite', async () => {
    const store = useLumiCurrentStateStore()
    const loadWorkingMemory = vi.fn(async ({ identity }: {
      identity: {
        actorId: string
        personaId: string
        conversationId: string
        conversationType: 'direct' | 'group' | 'internal'
        participantUserIds: string[]
      }
    }) => {
      const now = '2026-07-29T09:00:00.000Z'
      return {
        ...createLumiWorkingMemory({
          personId: identity.actorId,
          personaId: identity.personaId,
          conversationId: identity.conversationId,
          conversationType: identity.conversationType,
          now,
        }),
        activeTopics: [{
          id: `topic:${identity.conversationId}`,
          value: `topic for ${identity.conversationId}`,
          evidenceIds: [`evidence:${identity.conversationId}`],
          sourceMessageIds: [`message:${identity.conversationId}`],
          updatedAt: now,
          expiresAt: '2026-07-30T09:00:00.000Z',
        }],
        projects: [{
          id: `project:${identity.conversationId}`,
          value: `project for ${identity.conversationId}`,
          evidenceIds: [`evidence:${identity.conversationId}`],
          sourceMessageIds: [`message:${identity.conversationId}`],
          updatedAt: now,
          expiresAt: '2026-07-30T09:00:00.000Z',
        }],
        continuationPoint: `continue ${identity.conversationId}`,
        sourceMessageIds: [`message:${identity.conversationId}`],
      }
    })
    store.setCognitiveBridge({ loadWorkingMemory })
    store.setActiveStateUser(LUMI_DOGGY_USER_ID)
    store.setActiveStateConversation('direct:doggy:one')

    await store.refreshCognitiveProjection({
      conversationId: 'direct:doggy:one',
      conversationType: 'direct',
      actorId: LUMI_DOGGY_USER_ID,
      participantIds: [LUMI_DOGGY_USER_ID],
    })
    await store.refreshCognitiveProjection({
      conversationId: 'direct:doggy:two',
      conversationType: 'direct',
      actorId: LUMI_DOGGY_USER_ID,
      participantIds: [LUMI_DOGGY_USER_ID],
    })

    expect(store.buildPromptContext(LUMI_DOGGY_USER_ID, 'direct:doggy:one')).toContain('topic for direct:doggy:one')
    expect(store.buildPromptContext(LUMI_DOGGY_USER_ID, 'direct:doggy:one')).not.toContain('direct:doggy:two')
    expect(store.buildPromptContext(LUMI_DOGGY_USER_ID, 'direct:doggy:two')).toContain('project for direct:doggy:two')
    expect(store.currentState.lastContinuationPoint).toBe('continue direct:doggy:one')
    await expect(store.saveCurrentState({ recentTopics: ['legacy overwrite'] }, LUMI_DOGGY_USER_ID)).rejects.toThrow(
      'Legacy current_state is read-only while unified cognitive working memory is active',
    )

    const callsBeforeGroup = loadWorkingMemory.mock.calls.length
    const group = await store.refreshCognitiveProjection({
      conversationId: 'group:doggy:moussy',
      conversationType: 'group',
      actorId: LUMI_DOGGY_USER_ID,
      participantIds: [LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID],
    })
    expect(group.recentTopics).toEqual([])
    expect(group.updatedAt).toBe('')
    expect(loadWorkingMemory).toHaveBeenCalledTimes(callsBeforeGroup)
  })
})
