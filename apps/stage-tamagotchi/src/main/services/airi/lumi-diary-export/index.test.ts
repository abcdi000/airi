import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { exportDiary } from '.'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('lumi diary migration export', () => {
  it('exports diary Markdown even when the plugin host is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-diary-export-'))
    temporaryRoots.push(root)
    const diaryDir = join(root, 'diary')
    await mkdir(diaryDir)
    await writeFile(join(diaryDir, '2026-07-21.md'), '# Lumi Diary\n\nA remembered day.', 'utf8')
    await writeFile(join(diaryDir, 'notes.txt'), 'not a diary entry', 'utf8')

    const result = await exportDiary({ defaultDiaryDir: diaryDir, configPaths: [] })

    expect(result.diaryDir).toBe(diaryDir)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.id).toBe('legacy-diary:2026-07-21')
    expect(result.entries[0]?.content).toContain('A remembered day.')
  })

  it('honors a valid configured diary directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-diary-config-'))
    temporaryRoots.push(root)
    const defaultDir = join(root, 'default')
    const configuredDir = join(root, 'configured')
    const configPath = join(root, 'config.json')
    await mkdir(defaultDir)
    await mkdir(configuredDir)
    await writeFile(configPath, JSON.stringify({ diaryDir: configuredDir }), 'utf8')
    await writeFile(join(configuredDir, '2026-06-05.md'), 'Configured diary.', 'utf8')

    const result = await exportDiary({ defaultDiaryDir: defaultDir, configPaths: [configPath] })

    expect(result.diaryDir).toBe(configuredDir)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.entryDate).toBe('2026-06-05')
  })
})
