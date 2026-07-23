import type { LumiMemoryCandidate, LumiMemoryFragment } from '@proj-airi/lumi-runtime'

import type {
  LumiMigrationImportCounts,
  LumiMigrationMessage,
  LumiServerDatabase,
  LumiValidatedMigrationPlan,
} from './database'

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { classifyLumiMemoryCandidate, normalizeMemoryScores } from '@proj-airi/lumi-runtime'

import { DOGGY_MOUSSY_GROUP_ID } from './database'
import { memoryVectorDigest, memoryVectorText } from './vectorService'

export const LUMI_CLIENT_MIGRATION_FORMAT = 'lumi-client-migration:v1'

export interface LumiClientMigrationPackageV1 {
  format: typeof LUMI_CLIENT_MIGRATION_FORMAT
  version: 1
  packageId: string
  createdAt: string
  payloadSha256: string
  payload: {
    archive: Record<string, unknown>
    diaryEntries: unknown[]
  }
}

export interface LumiMigrationReport {
  migrationId: string
  sourceDigest: string
  users: Array<{ id: string, displayName: string }>
  counts: {
    messages: number
    memories: number
    memoryVectors: number
    profiles: number
    shortTermStates: number
    emotionStates: number
    diaryEntries: number
    privateNotes: number
    autonomousState: number
  }
  privacy: Record<'global' | 'shared' | 'relationship' | 'group' | 'private', number>
  duplicatesWithinPackage: number
  warnings: string[]
}

/** Creates the signed envelope consumed by the server staging workflow. */
export function createLumiClientMigrationPackage(
  archive: Record<string, unknown>,
  diaryEntries: unknown[] = [],
): LumiClientMigrationPackageV1 {
  const payload = { archive, diaryEntries }
  return {
    format: LUMI_CLIENT_MIGRATION_FORMAT,
    version: 1,
    packageId: randomUUID(),
    createdAt: new Date().toISOString(),
    payloadSha256: digestPayload(payload),
    payload,
  }
}

/** Stages, validates, reports, and later transactionally appends a client migration. */
export class LumiServerMigrationService {
  constructor(
    private readonly database: LumiServerDatabase,
    private readonly stagingDirectory: string,
  ) {}

  async stage(input: unknown): Promise<LumiMigrationReport> {
    const migration = parsePackage(input)
    const { plan, report } = buildMigrationPlan(migration)
    validatePlan(plan)
    const directory = resolve(this.stagingDirectory)
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${migration.packageId}.json`)
    const temporaryPath = `${path}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(migration, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, path)
    try {
      this.database.recordStagedMigration({
        id: migration.packageId,
        sourceDigest: migration.payloadSha256,
        manifest: { format: migration.format, version: migration.version, createdAt: migration.createdAt },
        report: report as unknown as Record<string, unknown>,
      })
    }
    catch (error) {
      this.database.markMigrationFailed(migration.packageId, { error: 'Failed to record staged migration' })
      throw error
    }
    return report
  }

  async commit(migrationId: string): Promise<LumiMigrationImportCounts> {
    const id = requiredText(migrationId, 'migrationId', 160)
    const path = join(resolve(this.stagingDirectory), `${id}.json`)
    const migration = parsePackage(JSON.parse(await readFile(path, 'utf8')))
    if (migration.packageId !== id)
      throw new Error('Staged migration ID does not match its filename')
    const { plan } = buildMigrationPlan(migration)
    validatePlan(plan)
    try {
      return this.database.importValidatedMigration(id, plan)
    }
    catch (error) {
      this.database.markMigrationFailed(id, { error: 'Transactional import failed' })
      throw error
    }
  }
}

function parsePackage(input: unknown): LumiClientMigrationPackageV1 {
  const record = object(input, 'migration package')
  if (record.format !== LUMI_CLIENT_MIGRATION_FORMAT || record.version !== 1)
    throw new Error('Unsupported Lumi client migration package')
  const payload = object(record.payload, 'migration payload')
  const archive = object(payload.archive, 'Lumi data archive')
  const diaryEntries = Array.isArray(payload.diaryEntries) ? payload.diaryEntries : []
  const normalizedPayload = { archive, diaryEntries }
  const payloadSha256 = requiredText(record.payloadSha256, 'payloadSha256', 128)
  if (payloadSha256 !== digestPayload(normalizedPayload))
    throw new Error('Lumi client migration payload checksum mismatch')
  return {
    format: LUMI_CLIENT_MIGRATION_FORMAT,
    version: 1,
    packageId: requiredText(record.packageId, 'packageId', 160),
    createdAt: requiredText(record.createdAt, 'createdAt', 64),
    payloadSha256,
    payload: normalizedPayload,
  }
}

function buildMigrationPlan(migration: LumiClientMigrationPackageV1): { plan: LumiValidatedMigrationPlan, report: LumiMigrationReport } {
  const archive = migration.payload.archive
  if (archive.format !== 'lumi-data-archive:v6' || archive.version !== 6)
    throw new Error('Server migration requires lumi-data-archive:v6')
  const sections = object(archive.sections, 'archive sections')
  const identity = object(sections.identity, 'identity section')
  const users = array(identity.users, 'identity users').map(parsePerson)
  const knownUsers = new Set(users.map(user => user.id))
  const userSections = object(sections.users, 'user sections')
  const messages: LumiMigrationMessage[] = []
  const rawMemories: Array<{ userId: string, value: unknown }> = []
  const rawMemoryVectors: unknown[] = []
  const personStates: LumiValidatedMigrationPlan['personStates'] = []
  let profileCount = 0
  let shortTermCount = 0
  let emotionCount = 0

  for (const [userId, rawSections] of Object.entries(userSections)) {
    if (!knownUsers.has(userId))
      throw new Error(`Archive contains data for an unknown Lumi user: ${userId}`)
    const userData = object(rawSections, `user sections for ${userId}`)
    messages.push(...parseChatMessages(userId, userData.chatSessions))
    const memorySnapshot = object(userData.lumiMemory, `memory snapshot for ${userId}`)
    for (const memory of array(memorySnapshot.fragments, `memory fragments for ${userId}`))
      rawMemories.push({ userId, value: memory })
    rawMemoryVectors.push(...arrayOrEmpty(memorySnapshot.vectors))

    const profile = object(userData.lumiUserProfile, `profile for ${userId}`)
    personStates.push({ personId: userId, kind: 'profile', payload: profile, updatedAt: timestamp(profile.exportedAt) })
    profileCount += 1
    const currentState = object(userData.lumiCurrentState, `current state for ${userId}`)
    if (currentState.state && typeof currentState.state === 'object') {
      personStates.push({ personId: userId, kind: 'short-term', payload: object(currentState.state, 'current state'), updatedAt: timestamp(currentState.exportedAt) })
      shortTermCount += 1
    }
    const emotion = object(userData.lumiEmotion, `emotion for ${userId}`)
    if (emotion.snapshot && typeof emotion.snapshot === 'object') {
      const snapshot = object(emotion.snapshot, 'emotion snapshot')
      personStates.push({ personId: userId, kind: 'emotion', payload: snapshot, updatedAt: timestamp(snapshot.updatedAt) })
      personStates.push({ personId: userId, kind: 'relationship', payload: object(snapshot.relationship, 'relationship state'), updatedAt: timestamp(snapshot.updatedAt) })
      emotionCount += 1
    }
  }

  const roomLedgers = objectOrEmpty(sections.roomLedgers)
  for (const ledger of Object.values(roomLedgers))
    messages.push(...parseLedgerMessages(ledger, knownUsers))

  const localStorage = objectOrEmpty(sections.localStorage)
  const privateNotes = parsePrivateNotes(localStorage['settings/plugins/lumi-proactive-vision/private-notes'])
  const autonomousState = parseAutonomousState(localStorage)
  const diaryEntries = migration.payload.diaryEntries.map(parseDiaryEntry)
  const externalIdentities = arrayOrEmpty(identity.externalIdentities).map(parseExternalIdentity)
  const deduplicatedMessages = deduplicate(messages, message => message.id)
  const knownConversationIds = new Set([
    DOGGY_MOUSSY_GROUP_ID,
    ...users.map(user => `lumi-direct:${user.id}`),
    ...deduplicatedMessages.values.map(message => message.conversationId),
  ])
  let droppedGroupConversationReferences = 0
  const memories = rawMemories.map(({ userId, value }) => normalizeImportedMemory(
    userId,
    value,
    knownConversationIds,
    () => droppedGroupConversationReferences += 1,
  ))
  const deduplicatedMemories = deduplicate(memories, memory => memory.id)
  const memoriesById = new Map(deduplicatedMemories.values.map(memory => [memory.id, memory]))
  const rawMemoriesById = new Map<string, Record<string, unknown>>()
  for (const { value } of rawMemories) {
    const row = object(value, 'memory fragment')
    const id = requiredText(row.id, 'memory id', 160)
    if (!rawMemoriesById.has(id))
      rawMemoriesById.set(id, row)
  }
  const parsedVectorResults = rawMemoryVectors.map(value => parseMemoryVector(value, memoriesById, rawMemoriesById))
  const rejectedVectorCount = parsedVectorResults.filter(vector => vector === undefined).length
  const parsedVectors = parsedVectorResults.filter(vector => vector !== undefined)
  const deduplicatedVectors = deduplicate(parsedVectors, vector => `${vector.memoryId}\u001F${vector.model}`)
  const privacy = { global: 0, shared: 0, relationship: 0, group: 0, private: 0 }
  for (const memory of deduplicatedMemories.values)
    privacy[memory.scope ?? 'relationship'] += 1
  const plan: LumiValidatedMigrationPlan = {
    people: users,
    externalIdentities,
    messages: deduplicatedMessages.values.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    memories: deduplicatedMemories.values,
    memoryVectors: deduplicatedVectors.values,
    personStates,
    diaryEntries,
    privateNotes,
    autonomousState,
  }
  return {
    plan,
    report: {
      migrationId: migration.packageId,
      sourceDigest: migration.payloadSha256,
      users: users.map(user => ({ id: user.id, displayName: user.displayName })),
      counts: {
        messages: plan.messages.length,
        memories: plan.memories.length,
        memoryVectors: plan.memoryVectors.length,
        profiles: profileCount,
        shortTermStates: shortTermCount,
        emotionStates: emotionCount,
        diaryEntries: diaryEntries.length,
        privateNotes: privateNotes.length,
        autonomousState: autonomousState.length,
      },
      privacy,
      duplicatesWithinPackage: deduplicatedMessages.duplicates + deduplicatedMemories.duplicates + deduplicatedVectors.duplicates,
      warnings: [
        ...(diaryEntries.length === 0 ? ['No diary file attachments were included.'] : []),
        ...(droppedGroupConversationReferences > 0
          ? [`Removed ${droppedGroupConversationReferences} dangling group conversation references while retaining their privacy classification.`]
          : []),
        ...(rejectedVectorCount > 0
          ? [`Ignored ${rejectedVectorCount} stale or incompatible semantic vectors; the server will rebuild them.`]
          : []),
      ],
    },
  }
}

function parseMemoryVector(
  value: unknown,
  memoriesById: Map<string, LumiMemoryFragment>,
  rawMemoriesById: Map<string, Record<string, unknown>>,
): LumiValidatedMigrationPlan['memoryVectors'][number] | undefined {
  const row = object(value, 'memory vector')
  const memoryId = requiredText(row.memoryId, 'memory vector memoryId', 160)
  const memory = memoriesById.get(memoryId)
  const rawMemory = rawMemoriesById.get(memoryId)
  if (!memory || !rawMemory)
    return undefined
  const model = requiredText(row.model, 'memory vector model', 500)
  const signature = requiredText(row.signature, 'memory vector signature', 20_000)
  if (signature !== legacyMemoryVectorSignature(rawMemory))
    return undefined
  if (legacyMemoryVectorText(rawMemory) !== memoryVectorText(memory))
    return undefined
  const vector = array(row.vector, 'memory vector values').map((item) => {
    if (typeof item !== 'number' || !Number.isFinite(item))
      throw new Error('Memory vector contains a non-finite value')
    return item
  })
  if (vector.length === 0 || vector.length > 16_384)
    throw new Error('Memory vector has an invalid dimension count')
  return {
    memoryId,
    model,
    dimensions: vector.length,
    vector,
    contentDigest: memoryVectorDigest(memory),
    device: optionalText(row.device, 160),
    updatedAt: timestamp(row.updatedAt),
  }
}

function legacyMemoryVectorSignature(memory: Record<string, unknown>): string {
  return [
    requiredText(memory.updatedAt, 'memory vector updatedAt', 64),
    requiredText(memory.type, 'memory vector type', 80),
    requiredText(memory.status, 'memory vector status', 40),
    stringArrayOrEmpty(memory.tags).join('\u001F'),
    requiredText(memory.content, 'memory vector content', 100_000),
  ].join('\u001E')
}

function legacyMemoryVectorText(memory: Record<string, unknown>): string {
  const tags = Array.isArray(memory.tags)
    ? memory.tags.filter(tag => typeof tag === 'string')
    : []
  return [
    `type: ${requiredText(memory.type, 'memory vector type', 80)}`,
    tags.length ? `tags: ${tags.join(', ')}` : '',
    `content: ${requiredText(memory.content, 'memory vector content', 100_000)}`,
  ].filter(Boolean).join('\n').replace(/\s+/g, ' ').trim()
}

function parsePerson(value: unknown): LumiValidatedMigrationPlan['people'][number] {
  const row = object(value, 'Lumi user')
  const role = row.role === 'owner' ? 'owner' : 'member'
  const status = row.status === 'inactive' ? 'inactive' : 'active'
  return {
    id: requiredText(row.id, 'user id', 160),
    displayName: requiredText(row.displayName, 'display name', 200),
    preferredAddress: requiredText(row.preferredAddress ?? row.displayName, 'preferred address', 200),
    role,
    status,
    createdAt: timestamp(row.createdAt),
    updatedAt: timestamp(row.updatedAt),
  }
}

function parseExternalIdentity(value: unknown): LumiValidatedMigrationPlan['externalIdentities'][number] {
  const row = object(value, 'external identity')
  return {
    id: requiredText(row.id, 'external identity id', 160),
    personId: requiredText(row.userId, 'external identity user id', 160),
    provider: requiredText(row.provider, 'external identity provider', 160),
    providerInstanceId: requiredText(row.providerInstanceId, 'provider instance id', 160),
    externalUserId: requiredText(row.externalUserId, 'external user id', 240),
    createdAt: timestamp(row.createdAt),
  }
}

function parseChatMessages(userId: string, rawExport: unknown): LumiMigrationMessage[] {
  const exported = object(rawExport, 'chat sessions export')
  if (exported.format !== 'chat-sessions-index:v1')
    throw new Error('Invalid chat sessions export inside migration package')
  const sessions = object(exported.sessions, 'chat session records')
  const result: LumiMigrationMessage[] = []
  for (const [sessionId, value] of Object.entries(sessions)) {
    const session = object(value, 'chat session')
    const meta = object(session.meta, 'chat session metadata')
    const conversationType = meta.conversationType === 'group' ? 'group' : 'direct'
    const conversationId = conversationType === 'group'
      ? requiredText(meta.sessionId ?? sessionId, 'group conversation id', 240)
      : `lumi-direct:${userId}`
    const participants = conversationType === 'group'
      ? stringArray(meta.participantUserIds, 'group participants')
      : [userId]
    for (const rawMessage of array(session.messages, 'chat messages')) {
      const message = object(rawMessage, 'chat message')
      const role = message.role
      if (role !== 'user' && role !== 'assistant' && role !== 'system')
        continue
      const content = extractMessageText(message)
      if (!content)
        continue
      const createdAt = timestamp(message.createdAt)
      const id = typeof message.id === 'string' && message.id.trim()
        ? message.id.trim()
        : deterministicId('chat', `${conversationId}:${role}:${createdAt}:${content}`)
      result.push({
        id,
        conversationId,
        conversationType,
        title: optionalText(meta.title, 300) ?? (conversationType === 'group' ? 'Lumi group' : `${userId} and Lumi`),
        participantPersonIds: participants,
        role,
        actorPersonId: role === 'user' ? optionalText(message.actorId, 160) ?? userId : undefined,
        content,
        createdAt,
      })
    }
  }
  return result
}

function parseLedgerMessages(value: unknown, knownUsers: Set<string>): LumiMigrationMessage[] {
  const ledger = object(value, 'room ledger')
  const conversationId = requiredText(ledger.conversationId, 'ledger conversation id', 240)
  const events = array(ledger.events, 'ledger events')
  const participants = new Set<string>()
  const messages: LumiMigrationMessage[] = []
  for (const rawEvent of events) {
    const event = object(rawEvent, 'ledger event')
    const actorPersonId = optionalText(event.actorId, 160)
    if (actorPersonId && knownUsers.has(actorPersonId))
      participants.add(actorPersonId)
    const role = event.role === 'assistant' ? 'assistant' : event.role === 'system' ? 'system' : 'user'
    const content = extractMessageText(event)
    if (!content)
      continue
    messages.push({
      id: optionalText(event.id, 240) ?? deterministicId('ledger', `${conversationId}:${String(event.sequence)}:${content}`),
      conversationId,
      conversationType: 'group',
      title: 'Lumi group',
      participantPersonIds: [],
      role,
      actorPersonId: role === 'user' ? actorPersonId : undefined,
      content,
      createdAt: timestamp(event.createdAt),
    })
  }
  const participantPersonIds = [...participants]
  return messages.map(message => ({ ...message, participantPersonIds }))
}

function normalizeImportedMemory(
  userId: string,
  value: unknown,
  knownConversationIds: ReadonlySet<string>,
  onDroppedGroupConversationReference: () => void,
): LumiMemoryFragment {
  const row = object(value, 'memory fragment')
  const candidate: LumiMemoryCandidate = {
    type: requiredText(row.type, 'memory type', 80) as LumiMemoryCandidate['type'],
    content: requiredText(row.content, 'memory content', 100_000),
    sourceMessageId: optionalText(row.sourceMessageId, 240),
    confidence: number(row.confidence, 0.5),
    importance: number(row.importance, 0.5),
    emotionalIntensity: number(row.emotionalIntensity, 0.5),
    relationshipRelevance: number(row.relationshipRelevance, 0.5),
    decay: number(row.decay, 0.1),
    tags: stringArrayOrEmpty(row.tags),
    status: 'candidate',
    reason: 'Validated offline migration',
    scope: optionalText(row.scope, 40) as LumiMemoryCandidate['scope'],
    visibility: optionalText(row.visibility, 40) as LumiMemoryCandidate['visibility'],
    sensitivity: optionalText(row.sensitivity, 40) as LumiMemoryCandidate['sensitivity'],
    subjectUserIds: stringArrayOrEmpty(row.subjectUserIds),
  }
  const sourceConversationType = row.sourceConversationType === 'group' ? 'group' : 'import'
  const sourceConversationId = optionalText(row.conversationId, 240)
  const conversationId = sourceConversationType === 'group'
    ? sourceConversationId && knownConversationIds.has(sourceConversationId)
      ? sourceConversationId
      : undefined
    : `lumi-direct:${userId}`
  if (sourceConversationType === 'group' && sourceConversationId && !conversationId)
    onDroppedGroupConversationReference()
  const participantUserIds = stringArrayOrEmpty(row.participantUserIds)
  const classification = classifyLumiMemoryCandidate(candidate, {
    actorId: userId,
    personaId: 'lumi',
    conversationId,
    conversationType: sourceConversationType,
    participantUserIds,
    requestedScope: candidate.scope,
    requestedVisibility: candidate.visibility,
    requestedSensitivity: candidate.sensitivity,
    requestedSubjectUserIds: candidate.subjectUserIds,
  })
  return normalizeMemoryScores({
    id: requiredText(row.id, 'memory id', 160),
    userId,
    personaId: 'lumi',
    conversationId,
    type: candidate.type,
    content: candidate.content,
    sourceMessageId: candidate.sourceMessageId,
    confidence: candidate.confidence,
    importance: candidate.importance,
    emotionalIntensity: candidate.emotionalIntensity,
    relationshipRelevance: candidate.relationshipRelevance,
    decay: candidate.decay,
    tags: candidate.tags,
    status: isMemoryStatus(row.status) ? row.status : 'candidate',
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
    lastUsedAt: optionalText(row.lastUsedAt, 64),
    ...classification,
  })
}

function parseDiaryEntry(value: unknown): LumiValidatedMigrationPlan['diaryEntries'][number] {
  const row = object(value, 'diary entry')
  const content = requiredText(row.content, 'diary content', 1_000_000)
  const createdAt = timestamp(row.createdAt ?? row.date)
  return {
    id: optionalText(row.id, 160) ?? deterministicId('diary', `${String(row.date)}:${content}`),
    entryDate: requiredText(row.entryDate ?? row.date ?? new Date(createdAt).toISOString().slice(0, 10), 'diary date', 40),
    title: optionalText(row.title, 300) ?? 'Lumi diary',
    content,
    mood: optionalText(row.mood, 160),
    tags: stringArrayOrEmpty(row.tags),
    sourceSummary: optionalText(row.sourceSummary, 10_000),
    createdAt,
    updatedAt: timestamp(row.updatedAt ?? row.createdAt ?? row.date),
  }
}

function parsePrivateNotes(value: unknown): LumiValidatedMigrationPlan['privateNotes'] {
  const parsed = parseStoredJson(value)
  if (!Array.isArray(parsed))
    return []
  const notes: LumiValidatedMigrationPlan['privateNotes'] = []
  parsed.forEach((value, index) => {
    if (typeof value === 'string' && value.trim()) {
      const now = Date.now()
      notes.push({ id: deterministicId('note', value), content: value.trim(), sourceKind: 'legacy-local-storage', tags: [], createdAt: now, updatedAt: now })
      return
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return
    const row = value as Record<string, unknown>
    const content = optionalText(row.content ?? row.note ?? row.text, 1_000_000)
    if (!content)
      return
    const createdAt = timestamp(row.createdAt)
    notes.push({
      id: optionalText(row.id, 160) ?? deterministicId('note', `${index}:${content}`),
      content,
      sourceKind: optionalText(row.sourceKind, 160) ?? 'legacy-local-storage',
      sourceReference: optionalText(row.sourceReference, 1_000),
      tags: stringArrayOrEmpty(row.tags),
      createdAt,
      updatedAt: timestamp(row.updatedAt ?? row.createdAt),
    })
  })
  return notes
}

function parseAutonomousState(localStorage: Record<string, unknown>): LumiValidatedMigrationPlan['autonomousState'] {
  const allowed = [
    'settings/plugins/lumi-proactive-vision/autonomous-life',
    'settings/plugins/lumi-proactive-vision/self-todo',
    'settings/plugins/lumi-proactive-vision/lumiworld-manifest',
    'settings/plugins/lumi-proactive-vision/decision-log',
    'settings/plugins/lumi-proactive-vision/runtime-logs',
    'settings/plugins/lumi-self-adjustment/change-log',
  ]
  return allowed.flatMap((key) => {
    if (!(key in localStorage))
      return []
    const parsed = parseStoredJson(localStorage[key])
    return [{ key, payload: asPayload(parsed), updatedAt: Date.now() }]
  })
}

function validatePlan(plan: LumiValidatedMigrationPlan) {
  const users = new Set(plan.people.map(person => person.id))
  if (users.size !== plan.people.length)
    throw new Error('Migration contains duplicate Lumi person IDs')
  for (const identity of plan.externalIdentities) {
    if (!users.has(identity.personId))
      throw new Error('External identity references an unknown Lumi person')
  }
  for (const message of plan.messages) {
    if (message.role === 'user' && (!message.actorPersonId || !users.has(message.actorPersonId)))
      throw new Error('User message references an unknown Lumi person')
    if (message.participantPersonIds.length === 0 || message.participantPersonIds.some(id => !users.has(id)))
      throw new Error('Conversation has invalid Lumi participants')
  }
  for (const memory of plan.memories) {
    if (!users.has(memory.userId))
      throw new Error('Memory references an unknown Lumi person')
  }
}

function extractMessageText(message: Record<string, unknown>): string {
  if (typeof message.content === 'string')
    return message.content.trim().slice(0, 200_000)
  if (Array.isArray(message.content)) {
    return message.content.flatMap((part) => {
      if (typeof part === 'string')
        return [part]
      if (part && typeof part === 'object' && !Array.isArray(part) && typeof (part as Record<string, unknown>).text === 'string')
        return [String((part as Record<string, unknown>).text)]
      return []
    }).join('\n').trim().slice(0, 200_000)
  }
  if (Array.isArray(message.slices)) {
    return message.slices.flatMap((slice) => {
      if (slice && typeof slice === 'object' && !Array.isArray(slice) && (slice as Record<string, unknown>).type === 'text')
        return [String((slice as Record<string, unknown>).text ?? '')]
      return []
    }).join('').trim().slice(0, 200_000)
  }
  return ''
}

function deduplicate<T>(values: T[], key: (value: T) => string) {
  const unique = new Map<string, T>()
  let duplicates = 0
  for (const value of values) {
    const id = key(value)
    if (unique.has(id)) {
      duplicates += 1
      continue
    }
    unique.set(id, value)
  }
  return { values: [...unique.values()], duplicates }
}

function digestPayload(payload: unknown) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function deterministicId(namespace: string, value: string) {
  return `${namespace}:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string')
    return value
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

function asPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

function objectOrEmpty(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value))
    throw new Error(`${field} must be an array`)
  return value
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim()))
    throw new Error(`${field} must be a string array`)
  return [...new Set(value.map(item => item.trim()))]
}

function stringArrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))] : []
}

function requiredText(value: unknown, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized)
    throw new Error(`${field} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${field} is too long`)
  return normalized
}

function optionalText(value: unknown, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  return normalized || undefined
}

function timestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return Math.floor(value)
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed))
      return parsed
  }
  return Date.now()
}

function isoTimestamp(value: unknown) {
  return new Date(timestamp(value)).toISOString()
}

function number(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isMemoryStatus(value: unknown): value is LumiMemoryFragment['status'] {
  return value === 'candidate' || value === 'active' || value === 'rejected' || value === 'contradicted' || value === 'archived'
}
