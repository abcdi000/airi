import type { ChatSessionMeta, ChatSessionRecord, ChatSessionsIndex } from '../../types/chat-session'

import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe as baseDescribe, beforeEach, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'

import { LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID, useLumiIdentityStore } from '../lumi-identity'

const describe = baseDescribe.sequential

// Refs the store reads through the mocked `useAuthStore` / `useAiriCardStore`.
// Tests mutate these to simulate auth and card swaps.
const userIdRef = ref<string>('local')
const activeCardIdRef = ref<string>('default')
const systemPromptRef = ref<string>('')

const getIndexMock = vi.fn<(uid: string) => Promise<ChatSessionsIndex | null>>()
const saveIndexMock = vi.fn<(idx: ChatSessionsIndex) => Promise<void>>()
const getSessionMock = vi.fn<(id: string) => Promise<ChatSessionRecord | null>>()
const saveSessionMock = vi.fn<(id: string, rec: ChatSessionRecord) => Promise<void>>()
const deleteSessionRepoMock = vi.fn<(id: string) => Promise<void>>()
const linkSessionToUserMock = vi.fn<(userId: string, meta: ChatSessionMeta) => Promise<void>>()
const unlinkSessionFromUserMock = vi.fn<(userId: string, meta: ChatSessionMeta) => Promise<void>>()
const getOutboxMock = vi.fn<(uid: string) => Promise<any[]>>()
const dropOutboxForSessionMock = vi.fn<(uid: string, id: string) => Promise<void>>()
const getTombstonesMock = vi.fn<(uid: string) => Promise<string[]>>()
const removeTombstonesMock = vi.fn<(uid: string, ids: string[]) => Promise<void>>()

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: any) => store,
  }
})

describe('chat-session-store · Lumi main timeline', () => {
  it('uses a single deterministic main timeline for Lumi and marks old sessions as legacy', async () => {
    const oldMeta: ChatSessionMeta = {
      sessionId: 'old-lumi-session',
      userId: 'local',
      characterId: 'lumi',
      conversationType: 'direct',
      participantUserIds: ['local'],
      createdAt: 10,
      updatedAt: 20,
    }
    const oldIndex: ChatSessionsIndex = {
      userId: 'local',
      characters: {
        lumi: {
          activeSessionId: 'old-lumi-session',
          sessions: { 'old-lumi-session': oldMeta },
        },
      },
    }
    getIndexMock.mockResolvedValue(oldIndex)
    getSessionMock.mockResolvedValue({
      meta: oldMeta,
      messages: [
        { role: 'system', content: 'system', id: 'sys' },
        { role: 'user', content: 'Doggy old message', id: 'u1' },
      ] as any,
    })
    activeCardIdRef.value = 'lumi'

    // The store import is intentionally delayed until all Vitest mocks are registered.
    // eslint-disable-next-line ts/no-use-before-define
    const store = useChatSessionStore()
    await store.initialize()

    expect(store.activeSessionId).not.toBe('old-lumi-session')
    expect(store.sessionMetas[store.activeSessionId]?.timelineType).toBe('main')
    expect(store.sessionMetas['old-lumi-session']?.timelineType).toBe('legacy')
    expect(store.sessionMetas['old-lumi-session']?.parentTimelineId).toBe(store.activeSessionId)
    expect(store.getSessionMessages(store.activeSessionId).some(message => message.id === 'u1')).toBe(true)
  })

  it('clears only the visible Lumi chat window without deleting stored main timeline messages', async () => {
    activeCardIdRef.value = 'lumi'
    // The store import is intentionally delayed until all Vitest mocks are registered.
    // eslint-disable-next-line ts/no-use-before-define
    const store = useChatSessionStore()
    await store.initialize()
    const sessionId = store.activeSessionId
    store.setSessionMessages(sessionId, [
      { role: 'system', content: 'system', id: 'sys' },
      { role: 'user', content: 'first visible message', id: 'u1' },
      { role: 'assistant', content: 'reply', id: 'a1', slices: [], tool_results: [] },
    ] as any)

    store.cleanupMessages(sessionId)
    await flushMicrotasks()

    expect(store.getSessionMessages(sessionId).map(message => message.id)).toEqual(['sys', 'u1', 'a1'])
    expect(store.getVisibleSessionMessages(sessionId)).toEqual([])
    expect(store.sessionMetas[sessionId]?.visibleFromMessageId).toBe('a1')
  })
})

vi.mock('../auth', () => ({
  useAuthStore: () => ({ userId: userIdRef }),
}))

vi.mock('../modules/airi-card', () => ({
  useAiriCardStore: () => ({
    activeCardId: activeCardIdRef,
    systemPrompt: systemPromptRef,
  }),
}))

vi.mock('../../database/repos/chat-sessions.repo', () => ({
  chatSessionsRepo: {
    getIndex: (uid: string) => getIndexMock(uid),
    saveIndex: (idx: ChatSessionsIndex) => saveIndexMock(idx),
    getSession: (id: string) => getSessionMock(id),
    saveSession: (id: string, rec: ChatSessionRecord) => saveSessionMock(id, rec),
    deleteSession: (id: string) => deleteSessionRepoMock(id),
    linkSessionToUser: (uid: string, meta: ChatSessionMeta) => linkSessionToUserMock(uid, meta),
    unlinkSessionFromUser: (uid: string, meta: ChatSessionMeta) => unlinkSessionFromUserMock(uid, meta),
    getOutbox: (uid: string) => getOutboxMock(uid),
    enqueueOutbox: vi.fn().mockResolvedValue(undefined),
    dequeueOutbox: vi.fn().mockResolvedValue(undefined),
    updateOutboxEntries: vi.fn().mockResolvedValue(undefined),
    dropOutboxForSession: (uid: string, id: string) => dropOutboxForSessionMock(uid, id),
    getTombstones: (uid: string) => getTombstonesMock(uid),
    addTombstone: vi.fn().mockResolvedValue(undefined),
    removeTombstones: (uid: string, ids: string[]) => removeTombstonesMock(uid, ids),
  },
}))

vi.mock('../../libs/auth', () => ({
  getAuthToken: vi.fn().mockResolvedValue('test-token'),
}))

vi.mock('../../libs/auth-fetch', () => ({
  authedFetch: vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
}))

vi.mock('../../libs/server', () => ({
  SERVER_URL: 'http://test',
}))

// Inert chat-sync surface. The store doesn't drive any cloud writes in these
// tests (anonymous user for one, deferred index for the other), so noops are
// sufficient. We keep `extractMessageText` realistic so message previews work.
vi.mock('../../libs/chat-sync', () => ({
  applyCreateActions: vi.fn().mockResolvedValue([]),
  reconcileLocalAndRemote: vi.fn().mockReturnValue({ adopt: [], claim: [], create: [] }),
  createCloudChatMapper: () => ({
    listChats: vi.fn().mockResolvedValue([]),
    deleteChat: vi.fn().mockResolvedValue(undefined),
  }),
  createChatWsClient: () => ({
    status: () => 'idle' as const,
    connect: vi.fn(),
    disconnect: vi.fn(),
    destroy: vi.fn(),
    sendMessages: vi.fn().mockResolvedValue({ ok: true }),
    pullMessages: vi.fn().mockResolvedValue({ messages: [], maxSeq: 0 }),
    onNewMessages: () => () => {},
    onStatusChange: () => () => {},
  }),
  extractMessageText: (m: any) => (typeof m?.content === 'string' ? m.content : ''),
  isCloudSyncableMessage: () => false,
  mergeCloudMessagesIntoLocal: () => ({ dirty: false, messages: [], maxSeq: 0 }),
}))

const { useChatSessionStore } = await import('./session-store')

beforeEach(() => {
  setActivePinia(createPinia())
  userIdRef.value = 'local'
  activeCardIdRef.value = 'default'
  systemPromptRef.value = ''

  getIndexMock.mockReset().mockResolvedValue(null)
  saveIndexMock.mockReset().mockResolvedValue(undefined)
  getSessionMock.mockReset().mockResolvedValue(null)
  saveSessionMock.mockReset().mockResolvedValue(undefined)
  deleteSessionRepoMock.mockReset().mockResolvedValue(undefined)
  linkSessionToUserMock.mockReset().mockResolvedValue(undefined)
  unlinkSessionFromUserMock.mockReset().mockResolvedValue(undefined)
  getOutboxMock.mockReset().mockResolvedValue([])
  dropOutboxForSessionMock.mockReset().mockResolvedValue(undefined)
  getTombstonesMock.mockReset().mockResolvedValue([])
  removeTombstonesMock.mockReset().mockResolvedValue(undefined)
})

describe('chat-session-store group conversations', () => {
  it('keeps Lumi online projections out of the offline IndexedDB archive', async () => {
    activeCardIdRef.value = 'lumi'
    const store = useChatSessionStore()
    const meta: ChatSessionMeta = {
      sessionId: 'server-direct-doggy',
      userId: 'doggy-user',
      characterId: 'lumi',
      conversationType: 'direct',
      participantUserIds: ['doggy-user'],
      title: 'Doggy and Lumi',
      createdAt: 10,
      updatedAt: 20,
    }

    store.applyOnlineProjection({
      activeSessionId: meta.sessionId,
      sessionMessages: { [meta.sessionId]: [{ role: 'user', content: 'online only', id: 'online-1' } as any] },
      sessionMetas: { [meta.sessionId]: meta },
      index: {
        userId: meta.userId,
        characters: {
          lumi: { activeSessionId: meta.sessionId, sessions: { [meta.sessionId]: meta } },
        },
      },
    })
    store.setSessionMessages(meta.sessionId, [
      ...store.getSessionMessages(meta.sessionId),
      { role: 'assistant', content: 'still online only', id: 'online-2', slices: [], tool_results: [] } as any,
    ])
    store.setActiveSession(meta.sessionId)
    await flushMicrotasks()

    expect(store.onlineProjectionActive).toBe(true)
    expect(saveSessionMock).not.toHaveBeenCalled()
    expect(saveIndexMock).not.toHaveBeenCalled()

    await store.clearOnlineProjection()

    expect(store.onlineProjectionActive).toBe(false)
    expect(store.getSessionMessages(meta.sessionId).some(message => message.id === 'online-1' || message.id === 'online-2')).toBe(false)
  })

  it('creates one shared Lumi session and links it into every other participant index', async () => {
    activeCardIdRef.value = 'lumi'
    const store = useChatSessionStore()

    const sessionId = await store.createGroupSession(['moussy-user'], { title: 'Doggy, Moussy and Lumi' })
    const meta = store.sessionMetas[sessionId]

    expect(meta).toMatchObject({
      conversationType: 'group',
      participantUserIds: ['local', 'moussy-user'],
      characterId: 'lumi',
    })
    expect(linkSessionToUserMock).toHaveBeenCalledWith('moussy-user', meta)
    expect(store.getInteractionContext(sessionId)).toMatchObject({
      conversationId: sessionId,
      conversationType: 'group',
      actorId: 'local',
      participantIds: ['local', 'moussy-user'],
    })
  })

  it('persists a structured-cloneable snapshot after a group session becomes reactive', async () => {
    // ROOT CAUSE:
    //
    // Session metadata read back from Pinia contains Vue proxies. A shallow
    // metadata spread retained the proxied participant array, so IndexedDB
    // rejected later chat saves with DataCloneError.
    saveSessionMock.mockImplementation(async (_sessionId, record) => {
      structuredClone(record)
    })
    activeCardIdRef.value = 'lumi'
    const store = useChatSessionStore()
    const sessionId = await store.createGroupSession(['moussy-user'])
    saveSessionMock.mockClear()

    store.setSessionMessages(sessionId, [
      { role: 'user', content: 'hello from Doggy', id: 'message-1' },
    ] as any)
    await flushMicrotasks()

    expect(saveSessionMock).toHaveBeenCalledOnce()
  })

  it('removes a participant reference while preserving the shared group record', async () => {
    await initializeLumiIdentityForRemoteTests()
    activeCardIdRef.value = 'lumi'
    const store = useChatSessionStore()
    const sessionId = await store.createGroupSession([LUMI_MOUSSY_USER_ID], { title: 'Shared room' })
    const createdMeta = store.sessionMetas[sessionId]!
    const storedRecord = saveSessionMock.mock.calls[0]?.[1]
    getSessionMock.mockResolvedValue(storedRecord ?? { meta: createdMeta, messages: [] })
    const thirdUserId = 'lumi-user-third'
    const identityStore = useLumiIdentityStore()
    await identityStore.importSnapshot({
      users: [
        ...identityStore.users,
        { id: thirdUserId, displayName: 'Third', preferredAddress: 'Third', role: 'member', status: 'active', createdAt: '2026-07-21T00:00:00.000Z', updatedAt: '2026-07-21T00:00:00.000Z' },
      ],
      externalIdentities: [...identityStore.externalIdentities],
      activeUserId: LUMI_DOGGY_USER_ID,
      migrationVersion: 'multi-user-v1',
    })
    unlinkSessionFromUserMock.mockClear()

    const updated = await store.updateGroupSession(sessionId, [thirdUserId], { title: 'Updated room' })

    expect(updated.participantUserIds).toEqual([LUMI_DOGGY_USER_ID, thirdUserId])
    expect(updated.title).toBe('Updated room')
    expect(unlinkSessionFromUserMock).toHaveBeenCalledWith(LUMI_MOUSSY_USER_ID, createdMeta)
    expect(linkSessionToUserMock).toHaveBeenCalledWith(thirdUserId, updated)
    expect(deleteSessionRepoMock).not.toHaveBeenCalled()
  })

  it('creates a detached direct timeline for a verified remote actor', async () => {
    await initializeLumiIdentityForRemoteTests()
    activeCardIdRef.value = 'lumi'
    const store = useChatSessionStore()

    const sessionId = await store.ensureSessionForActor(LUMI_MOUSSY_USER_ID)
    const interaction = store.getInteractionContextForActor(sessionId, LUMI_MOUSSY_USER_ID)

    expect(store.sessionMetas[sessionId]).toMatchObject({
      userId: LUMI_MOUSSY_USER_ID,
      conversationType: 'direct',
      participantUserIds: [LUMI_MOUSSY_USER_ID],
    })
    expect(interaction).toMatchObject({
      actorId: LUMI_MOUSSY_USER_ID,
      actorDisplayName: 'Moussy',
      participantIds: [LUMI_MOUSSY_USER_ID],
    })
    expect(linkSessionToUserMock).toHaveBeenCalledWith(
      LUMI_MOUSSY_USER_ID,
      expect.objectContaining({ sessionId }),
    )
  })

  it('rejects a remote actor that is not a participant in the requested conversation', async () => {
    await initializeLumiIdentityForRemoteTests()
    const groupMeta: ChatSessionMeta = {
      sessionId: 'doggy-private-session',
      userId: LUMI_DOGGY_USER_ID,
      characterId: 'lumi',
      conversationType: 'direct',
      participantUserIds: [LUMI_DOGGY_USER_ID],
      createdAt: 1,
      updatedAt: 1,
    }
    getSessionMock.mockResolvedValue({ meta: groupMeta, messages: [] })
    const store = useChatSessionStore()

    await expect(store.ensureSessionForActor(
      LUMI_MOUSSY_USER_ID,
      groupMeta.sessionId,
    )).rejects.toThrow('not a participant')
  })
})

async function initializeLumiIdentityForRemoteTests() {
  const now = '2026-07-21T00:00:00.000Z'
  const snapshot = {
    users: [
      { id: LUMI_DOGGY_USER_ID, displayName: 'Doggy', preferredAddress: 'Doggy', role: 'owner' as const, status: 'active' as const, createdAt: now, updatedAt: now },
      { id: LUMI_MOUSSY_USER_ID, displayName: 'Moussy', preferredAddress: 'Moussy', role: 'member' as const, status: 'active' as const, createdAt: now, updatedAt: now },
    ],
    externalIdentities: [],
    activeUserId: LUMI_DOGGY_USER_ID,
    migrationVersion: 'multi-user-v1',
  }
  const identityStore = useLumiIdentityStore()
  identityStore.setBridge({
    getSnapshot: async () => snapshot,
    createUser: async () => snapshot,
    updateUser: async () => snapshot,
    setActiveUser: async () => snapshot,
    linkExternalIdentity: async () => snapshot,
    replaceSnapshot: async value => value,
  })
  await identityStore.initialize()
}

afterEach(() => {
  try {
    useChatSessionStore().$dispose()
  }
  catch {
    // Store may not have been instantiated in a failed setup.
  }
})

async function flushMicrotasks(rounds = 8) {
  for (let i = 0; i < rounds; i++)
    await Promise.resolve()
}

describe('chat-session-store · user swap during in-flight ensureActiveSessionForCharacter', () => {
  // ROOT CAUSE:
  //
  // ensureActiveSessionForCharacter caches `ensureActivePromise` for singleflight
  // and the IIFE captures `currentUserId` at start. When `userId` flips A → B
  // mid-flight:
  //   1. The userId watcher calls clearInMemoryState (resets sessionMetas /
  //      index / activeSessionId), but does NOT reset `ensureActivePromise`.
  //   2. A's IIFE eventually resumes after its awaited IDB read completes and
  //      writes A's session record back into the now-empty B state — leak.
  //   3. Any subsequent ensureActiveSessionForCharacter call (e.g. from the
  //      [userId, activeCardId] watcher) returns A's stale promise instead of
  //      starting a fresh hydrate for B — B silently sees no sessions.
  //
  // We fix this by:
  //   - bumping an `ensureActiveEpoch` and nulling `ensureActivePromise` in
  //     `clearInMemoryState`,
  //   - re-checking the captured epoch after each await inside the IIFE,
  //   - re-checking `sessionMetas[sessionId]` inside `loadSession` so the
  //     post-IDB write does not resurrect cleared state,
  //   - triggering a fresh hydrate from the userId watcher itself so the new
  //     user actually loads.
  it('runs a fresh hydrate for the new user and discards the stale write from the old user', async () => {
    const aSessionMeta: ChatSessionMeta = {
      sessionId: 'sess-A',
      userId: 'A',
      characterId: 'default',
      conversationType: 'direct',
      participantUserIds: ['A'],
      createdAt: 1,
      updatedAt: 1,
    }
    const aIndex: ChatSessionsIndex = {
      userId: 'A',
      characters: {
        default: {
          activeSessionId: 'sess-A',
          sessions: { 'sess-A': aSessionMeta },
        },
      },
    }
    const bSessionMeta: ChatSessionMeta = {
      sessionId: 'sess-B',
      userId: 'B',
      characterId: 'default',
      conversationType: 'direct',
      participantUserIds: ['B'],
      createdAt: 2,
      updatedAt: 2,
    }
    const bIndex: ChatSessionsIndex = {
      userId: 'B',
      characters: {
        default: {
          activeSessionId: 'sess-B',
          sessions: { 'sess-B': bSessionMeta },
        },
      },
    }

    let resolveASessionGet: ((rec: ChatSessionRecord | null) => void) | undefined
    getIndexMock.mockImplementation((uid: string) => {
      if (uid === 'A')
        return Promise.resolve(aIndex)
      if (uid === 'B')
        return Promise.resolve(bIndex)
      return Promise.resolve(null)
    })
    getSessionMock.mockImplementation((id: string) => {
      // A's session getSession is the slow await we use to hold the IIFE open
      // until after the user swap fires.
      if (id === 'sess-A') {
        return new Promise<ChatSessionRecord | null>((resolve) => {
          resolveASessionGet = resolve
        })
      }
      if (id === 'sess-B')
        return Promise.resolve({ meta: bSessionMeta, messages: [] })
      return Promise.resolve(null)
    })

    userIdRef.value = 'A'
    const store = useChatSessionStore()

    // Kick off initialize; it will await ensureActiveSessionForCharacter, which
    // will await loadSession('sess-A') → getSession('sess-A') (deferred).
    const initPromise = store.initialize()
    await flushMicrotasks()

    // Sanity: A's getSession was reached and is parked.
    expect(getSessionMock).toHaveBeenCalledWith('sess-A')
    expect(resolveASessionGet).toBeDefined()

    // Auth swap mid-flight.
    userIdRef.value = 'B'
    await nextTick()
    await flushMicrotasks()

    // Resolve A's IDB read AFTER the swap. With the bug, A's IIFE writes
    // sess-A back into the cleared sessionMetas.
    resolveASessionGet!({ meta: aSessionMeta, messages: [] })
    await initPromise.catch(() => {})
    await flushMicrotasks()

    // B's hydrate must have fired — without the fix, the [userId, activeCardId]
    // watcher returned the stale A promise and B never loaded.
    expect(getIndexMock).toHaveBeenCalledWith('B')
    expect(store.sessionMetas['sess-B']).toBeDefined()

    // A's data must NOT have leaked into B's state.
    expect(store.sessionMetas['sess-A']).toBeUndefined()
  })
})

describe('chat-session-store · loadSession vs concurrent deleteSession', () => {
  // ROOT CAUSE:
  //
  // loadSession kicks off `chatSessionsRepo.getSession(id)` and writes the
  // returned record back into reactive state on resolve. If `deleteSession(id)`
  // runs synchronously between the getSession() call and its resolution, the
  // post-await `sessionMetas.value[sessionId] = stored.meta` write resurrects
  // the deleted entry — and `loadedSessions.add(id)` then short-circuits every
  // future loadSession retry, locking the resurrection in.
  //
  // The drawer's batch loadSession + per-row trash button is the production
  // path that hits this race.
  //
  // We fix this by re-checking `sessionMetas.value[sessionId]` inside
  // loadSession after the await; if the session is gone, skip the write-back
  // and skip `loadedSessions.add` so a subsequent (legitimate) load can retry.
  it('does not resurrect a session deleted while loadSession was awaiting IDB', async () => {
    const meta: ChatSessionMeta = {
      sessionId: 'sess-1',
      userId: 'local',
      characterId: 'default',
      conversationType: 'direct',
      participantUserIds: ['local'],
      createdAt: 1,
      updatedAt: 1,
    }

    let resolveGet: ((rec: ChatSessionRecord | null) => void) | undefined
    getSessionMock.mockImplementation((id: string) => {
      if (id === 'sess-1') {
        return new Promise<ChatSessionRecord | null>((resolve) => {
          resolveGet = resolve
        })
      }
      return Promise.resolve(null)
    })

    userIdRef.value = 'local'
    const store = useChatSessionStore()

    // Inject sess-1 into sessionMetas without going through createSession
    // (which would also pre-mark it loaded and short-circuit our test).
    store.applyRemoteSnapshot({
      activeSessionId: '',
      sessionMessages: {},
      sessionMetas: { 'sess-1': meta },
      index: null,
    })
    expect(store.sessionMetas['sess-1']).toBeDefined()

    // Start loadSession (don't await). getSession is now pending.
    const loadPromise = store.loadSession('sess-1')
    await flushMicrotasks()
    expect(resolveGet).toBeDefined()

    // Delete the session. In-memory clear is synchronous; IDB delete enqueues.
    await store.deleteSession('sess-1')
    expect(store.sessionMetas['sess-1']).toBeUndefined()

    // Resolve getSession with the stale stored record.
    resolveGet!({ meta, messages: [{ role: 'user', content: 'hi', id: 'm1' } as any] })
    await loadPromise
    await flushMicrotasks()

    // Without the fix, sess-1 reappears here.
    expect(store.sessionMetas['sess-1']).toBeUndefined()
  })
})
