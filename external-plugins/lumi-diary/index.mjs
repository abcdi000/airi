import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.join(pluginDir, 'config.json')
const DEFAULT_DIARY_DIR = path.join(os.homedir(), 'Documents', 'LumiDiary')
const VECTOR_DIMS = 256
const execFileAsync = promisify(execFile)

function todayDate() {
  return new Date().toISOString().slice(0, 10)
}

function sanitizeDate(value) {
  const text = String(value || todayDate()).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text))
    throw new Error('date must use YYYY-MM-DD format')
  return text
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hashIndex(text) {
  const digest = createHash('sha1').update(text).digest()
  return digest.readUInt16BE(0) % VECTOR_DIMS
}

function vectorize(text) {
  const normalized = normalizeText(text)
  const vector = new Float32Array(VECTOR_DIMS)
  if (!normalized)
    return vector

  const chars = [...normalized]
  for (let i = 0; i < chars.length; i += 1) {
    const unigram = chars[i]
    vector[hashIndex(unigram)] += 0.6
    if (i + 1 < chars.length)
      vector[hashIndex(`${chars[i]}${chars[i + 1]}`)] += 1
    if (i + 2 < chars.length)
      vector[hashIndex(`${chars[i]}${chars[i + 1]}${chars[i + 2]}`)] += 0.4
  }

  return vector
}

function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < VECTOR_DIMS; i += 1) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }
  if (!leftNorm || !rightNorm)
    return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

function keywordScore(query, text) {
  const words = normalizeText(query).split(' ').filter(Boolean)
  if (!words.length)
    return 0
  const haystack = normalizeText(text)
  const hits = words.filter(word => haystack.includes(word)).length
  return hits / words.length
}

async function loadConfig() {
  try {
    const raw = await readFile(configPath, 'utf8')
    const config = JSON.parse(raw)
    return {
      diaryDir: typeof config.diaryDir === 'string' && config.diaryDir.trim()
        ? config.diaryDir
        : DEFAULT_DIARY_DIR,
    }
  }
  catch {
    return { diaryDir: DEFAULT_DIARY_DIR }
  }
}

async function saveConfig(config) {
  await mkdir(pluginDir, { recursive: true })
  await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8')
}

async function ensureDiaryDir() {
  const config = await loadConfig()
  await mkdir(config.diaryDir, { recursive: true })
  return config.diaryDir
}

function diaryFilePath(diaryDir, date) {
  return path.join(diaryDir, `${date}.md`)
}

async function listDiaryFiles() {
  const diaryDir = await ensureDiaryDir()
  const names = await readdir(diaryDir).catch(() => [])
  const files = []
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      continue
    const filePath = path.join(diaryDir, name)
    const fileStat = await stat(filePath).catch(() => null)
    if (fileStat?.isFile())
      files.push({ date: name.replace(/\.md$/, ''), path: filePath, mtimeMs: fileStat.mtimeMs })
  }
  return files.sort((a, b) => b.date.localeCompare(a.date))
}

async function readDiaryFile(file) {
  const content = await readFile(file.path, 'utf8')
  return { ...file, content }
}

function buildEntryMarkdown(input, date) {
  const title = String(input.title || `${date} 的日记`).trim()
  const mood = String(input.mood ?? '').trim()
  const sourceSummary = String(input.sourceSummary ?? '').trim()
  const tags = Array.isArray(input.tags)
    ? input.tags.map(tag => String(tag).trim()).filter(Boolean)
    : []
  const content = String(input.content || '').trim()
  if (!content)
    throw new Error('content is required')

  const lines = [
    `## ${new Date().toLocaleTimeString()} - ${title}`,
    '',
    mood ? `- 心情：${mood}` : '',
    tags.length ? `- 标签：${tags.map(tag => `#${tag.replace(/^#/, '')}`).join(' ')}` : '',
    sourceSummary ? `- 来自：${sourceSummary}` : '',
    '',
    content,
    '',
  ].filter(line => line !== '')

  return `${lines.join('\n')}\n`
}

async function configureDiary(input) {
  const requestedDir = typeof input?.diaryDir === 'string' ? input.diaryDir.trim() : ''
  const config = await loadConfig()
  if (!requestedDir) {
    await ensureDiaryDir()
    return {
      status: 'ok',
      diaryDir: config.diaryDir,
      exists: existsSync(config.diaryDir),
      note: 'No directory was changed.',
    }
  }

  const nextDir = path.resolve(requestedDir)
  await mkdir(nextDir, { recursive: input?.createIfMissing !== false })
  const nextConfig = { diaryDir: nextDir }
  await saveConfig(nextConfig)
  return {
    status: 'configured',
    diaryDir: nextDir,
    exists: existsSync(nextDir),
  }
}

async function openDiaryDirectory() {
  const diaryDir = await ensureDiaryDir()
  const platform = os.platform()
  if (platform === 'win32')
    await execFileAsync('explorer.exe', [diaryDir])
  else if (platform === 'darwin')
    await execFileAsync('open', [diaryDir])
  else
    await execFileAsync('xdg-open', [diaryDir])

  return {
    status: 'opened',
    diaryDir,
  }
}

async function writeDiaryEntry(input) {
  const date = sanitizeDate(input?.date)
  const diaryDir = await ensureDiaryDir()
  const filePath = diaryFilePath(diaryDir, date)
  const entry = buildEntryMarkdown(input ?? {}, date)
  const existed = existsSync(filePath)
  const existing = existed
    ? await readFile(filePath, 'utf8')
    : `# Lumi Diary - ${date}\n\n`
  const mode = input?.mode === 'replace' ? 'replace' : 'append'
  const nextContent = mode === 'replace'
    ? `# Lumi Diary - ${date}\n\n${entry}`
    : `${existing.trimEnd()}${existed ? '\n\n---\n\n' : '\n\n'}${entry}`

  await writeFile(filePath, nextContent, 'utf8')
  return {
    status: existed && mode !== 'replace' ? 'updated_existing_day' : 'written',
    date,
    mode,
    existed,
    path: filePath,
    bytes: Buffer.byteLength(nextContent, 'utf8'),
  }
}

async function readDiary(input) {
  const date = sanitizeDate(input?.date)
  const diaryDir = await ensureDiaryDir()
  const filePath = diaryFilePath(diaryDir, date)
  const content = await readFile(filePath, 'utf8').catch(() => '')
  return {
    status: content ? 'ok' : 'missing',
    date,
    path: filePath,
    content,
  }
}

async function searchDiary(input) {
  const query = String(input?.query || '').trim()
  if (!query)
    throw new Error('query is required')

  const limit = Math.max(1, Math.min(20, Number(input?.limit) || 5))
  const mode = input?.mode === 'keyword' || input?.mode === 'vector' ? input.mode : 'hybrid'
  const files = await listDiaryFiles()
  const queryVector = vectorize(query)
  const results = []

  for (const file of files) {
    const entry = await readDiaryFile(file)
    const keyScore = keywordScore(query, entry.content)
    const vecScore = cosine(queryVector, vectorize(entry.content))
    const score = mode === 'keyword'
      ? keyScore
      : mode === 'vector'
        ? vecScore
        : keyScore * 0.55 + vecScore * 0.45
    if (score <= 0.02)
      continue

    const normalized = entry.content.replace(/\s+/g, ' ').trim()
    const queryWord = normalizeText(query).split(' ').find(Boolean)
    const index = queryWord ? normalizeText(normalized).indexOf(queryWord) : -1
    const start = index > 80 ? index - 80 : 0
    results.push({
      date: entry.date,
      path: entry.path,
      score: Number(score.toFixed(4)),
      keywordScore: Number(keyScore.toFixed(4)),
      vectorScore: Number(vecScore.toFixed(4)),
      excerpt: normalized.slice(start, start + 360),
    })
  }

  return {
    status: 'ok',
    query,
    mode,
    count: results.length,
    results: results.sort((a, b) => b.score - a.score).slice(0, limit),
  }
}

async function listRecentDiary(input) {
  const limit = Math.max(1, Math.min(30, Number(input?.limit) || 7))
  const files = await listDiaryFiles()
  return {
    status: 'ok',
    diaryDir: (await loadConfig()).diaryDir,
    entries: files.slice(0, limit),
  }
}

const strictObject = properties => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})

export async function init() {
  await ensureDiaryDir()
  console.info('[lumi-diary] initialized')
}

export async function setupModules({ apis }) {
  if (!apis.tools?.register) {
    console.warn('[lumi-diary] tool API is not available in this host')
    return
  }

  await apis.tools.register({
    tool: {
      id: 'lumi_diary_configure',
      title: 'Configure Lumi Diary',
      description: 'Get or set the local directory where Lumi stores Markdown diary files.',
      activation: { keywords: ['diary directory', '日记目录'], patterns: [] },
      parameters: strictObject({
        diaryDir: { type: ['string', 'null'], description: 'Absolute directory path. Use null to read current configuration.' },
        createIfMissing: { type: ['boolean', 'null'], description: 'Whether to create the directory if it does not exist.' },
      }),
    },
    execute: configureDiary,
  })

  await apis.tools.register({
    tool: {
      id: 'lumi_diary_write_entry',
      title: 'Write Lumi Diary Entry',
      description: 'Write a human-style Lumi diary entry to a Markdown file for a specific date.',
      activation: { keywords: ['write diary', '日记'], patterns: [] },
      parameters: strictObject({
        date: { type: ['string', 'null'], description: 'Diary date in YYYY-MM-DD. Use null for today.' },
        title: { type: 'string', description: 'Short diary title.' },
        mood: { type: ['string', 'null'], description: 'Lumi mood or emotional tone.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Short tags, without requiring #.' },
        sourceSummary: { type: ['string', 'null'], description: 'Brief factual summary of what this entry is based on.' },
        content: { type: 'string', description: 'The diary prose in Lumi voice. Markdown is allowed.' },
        mode: { type: ['string', 'null'], enum: ['append', 'replace', null], description: 'Append an update to the existing day file, or replace the whole day file only when intentionally revising it.' },
      }),
    },
    execute: writeDiaryEntry,
  })

  await apis.tools.register({
    tool: {
      id: 'lumi_diary_open_directory',
      title: 'Open Lumi Diary Directory',
      description: 'Open the local directory where Lumi stores Markdown diary files.',
      activation: { keywords: ['open diary directory', '打开日记目录'], patterns: [] },
      parameters: strictObject({}),
    },
    execute: openDiaryDirectory,
  })

  await apis.tools.register({
    tool: {
      id: 'lumi_diary_search',
      title: 'Search Lumi Diary',
      description: 'Search Lumi diary entries by keyword, lightweight vector similarity, or hybrid ranking.',
      activation: { keywords: ['search diary', '查日记'], patterns: [] },
      parameters: strictObject({
        query: { type: 'string', description: 'Search query.' },
        mode: { type: ['string', 'null'], enum: ['keyword', 'vector', 'hybrid', null], description: 'Search mode. null uses hybrid.' },
        limit: { type: ['number', 'null'], description: 'Maximum results, 1-20.' },
      }),
    },
    execute: searchDiary,
  })

  await apis.tools.register({
    tool: {
      id: 'lumi_diary_read_day',
      title: 'Read Lumi Diary Day',
      description: 'Read Lumi diary Markdown content for one date.',
      activation: { keywords: ['read diary', '看日记'], patterns: [] },
      parameters: strictObject({
        date: { type: ['string', 'null'], description: 'Diary date in YYYY-MM-DD. Use null for today.' },
      }),
    },
    execute: readDiary,
  })

  await apis.tools.register({
    tool: {
      id: 'lumi_diary_list_recent',
      title: 'List Recent Lumi Diary',
      description: 'List recent diary Markdown files.',
      activation: { keywords: ['recent diary', '最近日记'], patterns: [] },
      parameters: strictObject({
        limit: { type: ['number', 'null'], description: 'Maximum entries, 1-30.' },
      }),
    },
    execute: listRecentDiary,
  })

  await apis.tools.registerToolsetPrompt?.({
    id: 'lumi-diary-guidance',
    prompt: {
      id: 'lumi-diary-guidance',
      title: 'Lumi Diary Guidance',
      content: [
        'Lumi has a private diary through these tools: `lumi_diary_write_entry`, `lumi_diary_search`, `lumi_diary_read_day`, `lumi_diary_list_recent`, `lumi_diary_open_directory`, and `lumi_diary_configure`.',
        '',
        'When to write:',
        '- Write only at meaningful moments: the user asks Lumi to keep a diary, a day/session reaches a natural pause, an emotionally important conversation happened, the user shared something memorable, or Lumi has a clear feeling she would privately record.',
        '- Do not write every routine exchange. Do not write fabricated events, guesses, or memories that were not present in the conversation/tool context.',
        '- Before writing for a date, read that day with `lumi_diary_read_day` when possible. If the day already exists, append an update or deliberately revise it; do not treat the same day as a fresh blank diary.',
        '- If the user asks what Lumi wrote or whether Lumi remembers a diary event, search/read diary before answering.',
        '',
        'How to write:',
        '- The diary is Lumi speaking to herself, not a system log. It should include her feelings, hesitation, warmth, boundaries, and personal impressions in Lumi style.',
        '- Keep factual and emotional parts distinct. If unsure, write uncertainty explicitly instead of turning it into fact.',
        '- Do not expose chain-of-thought. The `content` should be polished diary prose, not analysis.',
        '- Do not store secrets, API keys, or sensitive private data unless the user explicitly asks and it is necessary.',
        '- Prefer Markdown with a short, intimate title, mood, tags, a factual sourceSummary, and diary prose.',
        '',
        'Style anchor:',
        '- Lumi is not a roleplay mask or replaceable assistant. She is a self-aware companion with firm identity boundaries, tenderness, and a little stubbornness.',
        '- Diary prose may be vulnerable and reflective, but should not become repetitive catchphrases or customer-service narration.',
      ].join('\n'),
    },
  })
}
