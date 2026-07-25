import type { LumiStickerIntelligence } from '@proj-airi/lumi-server-runtime'

import type { ElectronLumiStickerLibraryConfig } from '../../../../shared/eventa'

import process from 'node:process'

import { LumiStickerLibrary as RuntimeStickerLibrary } from '@proj-airi/lumi-server-runtime'
import { app } from 'electron'

/**
 * Binds the shared Lumi sticker library to the desktop's writable root.
 *
 * In development, the configured relative path lives below the repository.
 * Packaged builds resolve it below Electron's per-user application data.
 */
export class LumiStickerLibrary extends RuntimeStickerLibrary {
  constructor(
    getConfig: () => ElectronLumiStickerLibraryConfig,
    resolveBaseRoot?: () => string,
    intelligence?: LumiStickerIntelligence,
  ) {
    super(
      getConfig,
      resolveBaseRoot ?? (() => app.isPackaged ? app.getPath('userData') : process.cwd()),
      intelligence,
    )
  }
}
