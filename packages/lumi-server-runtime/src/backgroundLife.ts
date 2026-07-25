import type { LumiConsciousnessModel, LumiConsciousnessRequest } from './consciousness'
import type { LumiServerDatabase, LumiServerJob } from './database'
import type { LumiServerJobHandler } from './jobs'

export interface LumiBackgroundLifeOptions {
  database: LumiServerDatabase
  model: Pick<LumiConsciousnessModel, 'generate'>
  personaPrompt: string
  diary: {
    enabled: boolean
    /** Server-local 24-hour time. @default "23:00" */
    dailyTime: string
  }
  autonomousLife: {
    enabled: boolean
    /** @default 1200000 */
    minimumIntervalMs: number
    /** @default 2700000 */
    maximumIntervalMs: number
  }
}

/** Owns durable diary and autonomous reflection scheduling in Lumi Server. */
export class LumiBackgroundLife {
  constructor(private readonly options: LumiBackgroundLifeOptions) {
    parseDailyTime(options.diary.dailyTime)
    if (options.autonomousLife.minimumIntervalMs < 60_000 || options.autonomousLife.maximumIntervalMs < options.autonomousLife.minimumIntervalMs)
      throw new Error('Invalid autonomous life interval')
  }

  scheduleInitialJobs() {
    if (this.options.diary.enabled)
      this.options.database.enqueueJobIfIdle('diary-daily', {}, nextDailyTime(this.options.diary.dailyTime))
    if (this.options.autonomousLife.enabled)
      this.options.database.enqueueJobIfIdle('autonomous-life-tick', {}, Date.now() + this.nextLifeInterval())
  }

  handlers(): Record<string, LumiServerJobHandler> {
    return {
      'diary-daily': (job, signal) => this.writeDiary(job, signal),
      'autonomous-life-tick': (job, signal) => this.runLifeTick(job, signal),
    }
  }

  private async writeDiary(job: LumiServerJob, signal: AbortSignal) {
    signal.throwIfAborted()
    const now = new Date()
    if (this.options.diary.enabled && job.attempts === 1)
      this.options.database.enqueueJob('diary-daily', {}, nextDailyTime(this.options.diary.dailyTime, new Date(now.getTime() + 60_000)))
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const messages = this.options.database.recentMessagesForBackground(200, start.getTime())
    const request = this.backgroundRequest([
      'Write Lumi\'s private diary for today as polished Markdown prose.',
      'Separate facts from feelings. Do not invent events or expose chain-of-thought.',
      'This diary belongs to Lumi and is not a public chat response.',
      '',
      ...messages.map(message => `[${message.conversationType}; ${message.actorDisplayName ?? message.role}] ${message.content.slice(0, 1_200)}`),
    ].join('\n'))
    const result = await this.options.model.generate(request, () => {})
    signal.throwIfAborted()
    const content = result.text.trim()
    if (!content)
      throw new Error('Diary model returned empty content')
    const date = localDateKey(now)
    const id = this.options.database.appendDiaryEntry({
      date,
      title: `${date} Lumi diary`,
      content,
      tags: ['automatic'],
      sourceSummary: `${messages.length} server messages`,
    })
    return { diaryEntryId: id, messageCount: messages.length }
  }

  private async runLifeTick(job: LumiServerJob, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.options.autonomousLife.enabled && job.attempts === 1)
      this.options.database.enqueueJob('autonomous-life-tick', {}, Date.now() + this.nextLifeInterval())
    const previous = this.options.database.readAutonomousState('life') ?? {}
    const messages = this.options.database.recentMessagesForBackground(60, Date.now() - 24 * 60 * 60 * 1_000)
    const request = this.backgroundRequest([
      'Privately reflect on Lumi\'s current life continuity and choose one modest next thought or action.',
      'Do not claim real-world actions that tools did not complete. Keep private data private.',
      `Previous state: ${JSON.stringify(previous)}`,
      'Recent authorized server timeline:',
      ...messages.map(message => `[${message.conversationType}; ${message.actorDisplayName ?? message.role}] ${message.content.slice(0, 800)}`),
    ].join('\n'))
    const result = await this.options.model.generate(request, () => {})
    signal.throwIfAborted()
    const now = new Date().toISOString()
    const next = {
      ...previous,
      lastTickAt: now,
      lastReflection: result.text.trim().slice(0, 20_000),
      recentMessageCount: messages.length,
    }
    this.options.database.writeAutonomousState('life', next)
    return { updatedAt: now, messageCount: messages.length }
  }

  private backgroundRequest(content: string): LumiConsciousnessRequest {
    return {
      conversationId: 'lumi-background',
      conversationType: 'group',
      actorPersonId: 'lumi',
      actorDisplayName: 'Lumi',
      participantPersonIds: [],
      memories: [],
      personStates: [],
      messages: [
        { role: 'system', content: `${this.options.personaPrompt}\nThis is a server-owned background task.` },
        { role: 'user', content },
      ],
    }
  }

  private nextLifeInterval() {
    const { minimumIntervalMs, maximumIntervalMs } = this.options.autonomousLife
    return Math.floor(minimumIntervalMs + Math.random() * (maximumIntervalMs - minimumIntervalMs + 1))
  }
}

export function nextDailyTime(value: string, from = new Date()) {
  const { hour, minute } = parseDailyTime(value)
  const target = new Date(from)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= from.getTime())
    target.setDate(target.getDate() + 1)
  return target.getTime()
}

function parseDailyTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match)
    throw new Error('Diary daily time must use HH:mm')
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59)
    throw new Error('Diary daily time is outside the clock range')
  return { hour, minute }
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
