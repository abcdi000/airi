import type { ElectronLumiDiaryExportSnapshot } from '../../../../shared/eventa'

import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

interface DiaryExportOptions {
  defaultDiaryDir: string
  configPaths: string[]
}

async function configuredDiaryDir(configPaths: string[]): Promise<string | undefined> {
  for (const configPath of configPaths) {
    if (!existsSync(configPath))
      continue

    try {
      const config = JSON.parse(await readFile(configPath, 'utf8')) as { diaryDir?: unknown }
      if (typeof config.diaryDir === 'string' && config.diaryDir.trim() && isAbsolute(config.diaryDir))
        return config.diaryDir
    }
    catch {
      // A damaged optional plugin config must not block the complete data migration.
    }
  }
  return undefined
}

/**
 * Reads Lumi's Markdown diary without requiring the plugin host to be running.
 *
 * Use when:
 * - Building a complete offline-to-server migration package
 * - Recovering data while the diary plugin is disabled or still initializing
 *
 * Expects:
 * - Diary files use the plugin's `YYYY-MM-DD.md` format
 * - Configured diary directories are absolute paths
 *
 * Returns:
 * - Every readable diary entry in deterministic date order
 */
export async function exportDiary(options: DiaryExportOptions): Promise<ElectronLumiDiaryExportSnapshot> {
  const diaryDir = await configuredDiaryDir(options.configPaths) ?? options.defaultDiaryDir
  const names = await readdir(diaryDir).catch(() => [])
  const entries = []

  for (const name of names.sort()) {
    if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      continue

    const path = join(diaryDir, name)
    const fileStat = await stat(path).catch(() => undefined)
    if (!fileStat?.isFile())
      continue

    const entryDate = name.slice(0, -3)
    entries.push({
      id: `legacy-diary:${entryDate}`,
      entryDate,
      title: `${entryDate} 的日记`,
      content: await readFile(path, 'utf8'),
      sourceSummary: `Imported from ${path}`,
      createdAt: fileStat.birthtimeMs || fileStat.mtimeMs,
      updatedAt: fileStat.mtimeMs,
    })
  }

  return { diaryDir, entries }
}
