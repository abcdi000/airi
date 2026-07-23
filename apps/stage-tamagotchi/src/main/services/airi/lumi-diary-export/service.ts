import type { createContext } from '@moeru/eventa/adapters/electron/main'

import process from 'node:process'

import { join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import { exportDiary } from '.'
import { electronLumiDiaryExportAll } from '../../../../shared/eventa'

/**
 * Registers the read-only diary export used by complete data migrations.
 *
 * Use when:
 * - Preparing any renderer window that may host Lumi's data settings
 *
 * Expects:
 * - The Eventa context belongs to the target renderer window
 *
 * Returns:
 * - Nothing; the invoke handler remains attached to the context
 */
export function createLumiDiaryExportService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  defineInvokeHandler(params.context, electronLumiDiaryExportAll, async () => await exportDiary({
    defaultDiaryDir: join(app.getPath('documents'), 'LumiDiary'),
    configPaths: [
      join(app.getAppPath(), 'external-plugins', 'lumi-diary', 'config.json'),
      join(process.resourcesPath, 'external-plugins', 'lumi-diary', 'config.json'),
      join(process.cwd(), 'external-plugins', 'lumi-diary', 'config.json'),
    ],
  }))
}
