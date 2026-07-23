import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initializeLumiServerConfig, loadLumiServerConfig } from './config'

describe('lumi Server process configuration', () => {
  it('creates one private config and resolves its data directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-server-config-'))
    const path = join(directory, 'config', 'server.json')
    try {
      await initializeLumiServerConfig(path)
      const config = await loadLumiServerConfig(path)
      expect(config.authSecret.length).toBeGreaterThanOrEqual(32)
      expect(config.dataDirectory).toBe(join(directory, 'config', 'data'))
      expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('airiAccount')
      await expect(initializeLumiServerConfig(path)).rejects.toMatchObject({ code: 'EEXIST' })
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
