import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { migrateLegacyClientConfig, readLegacyClientConfigMigrationMarker } from './legacy-client-config'

describe('legacy client configuration migration', () => {
  const temporaryRoots: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  it('restores renderer configuration while preserving online credentials and creates a rollback backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-client-config-'))
    temporaryRoots.push(root)
    const source = join(root, 'legacy')
    const target = join(root, 'client')
    await mkdir(join(source, 'Local Storage', 'leveldb'), { recursive: true })
    await mkdir(join(source, 'IndexedDB'), { recursive: true })
    await mkdir(join(target, 'Local Storage', 'leveldb'), { recursive: true })
    await writeFile(join(source, 'Local Storage', 'leveldb', '000001.log'), 'legacy-modules', 'utf8')
    await writeFile(join(source, 'IndexedDB', 'providers.db'), 'legacy-providers', 'utf8')
    await writeFile(join(source, 'plugins-v1.json'), '{"plugins":["vision"]}', 'utf8')
    await writeFile(join(target, 'Local Storage', 'leveldb', '000001.log'), 'fresh-empty-profile', 'utf8')
    await writeFile(join(target, 'lumi-online-session.bin'), 'encrypted-session', 'utf8')
    await writeFile(join(target, 'lumi-runtime-role.json'), '{"mode":"online-client"}', 'utf8')

    const result = await migrateLegacyClientConfig({ legacyUserDataPath: source, targetUserDataPath: target })

    expect(result.migrated).toBe(true)
    expect(await readFile(join(target, 'Local Storage', 'leveldb', '000001.log'), 'utf8')).toBe('legacy-modules')
    expect(await readFile(join(target, 'IndexedDB', 'providers.db'), 'utf8')).toBe('legacy-providers')
    expect(await readFile(join(target, 'plugins-v1.json'), 'utf8')).toBe('{"plugins":["vision"]}')
    expect(await readFile(join(target, 'lumi-online-session.bin'), 'utf8')).toBe('encrypted-session')
    expect(await readFile(join(target, 'lumi-runtime-role.json'), 'utf8')).toBe('{"mode":"online-client"}')
    expect(await readFile(join(result.backupPath!, 'Local Storage', 'leveldb', '000001.log'), 'utf8')).toBe('fresh-empty-profile')
    expect(await readLegacyClientConfigMigrationMarker(target)).toMatchObject({ version: 1, source })
  })

  it('does not repeat a completed migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-client-config-'))
    temporaryRoots.push(root)
    const source = join(root, 'legacy')
    const target = join(root, 'client')
    await mkdir(join(source, 'Local Storage', 'leveldb'), { recursive: true })
    await writeFile(join(source, 'Local Storage', 'leveldb', '000001.log'), 'legacy', 'utf8')

    await migrateLegacyClientConfig({ legacyUserDataPath: source, targetUserDataPath: target })
    const repeated = await migrateLegacyClientConfig({ legacyUserDataPath: source, targetUserDataPath: target })

    expect(repeated).toEqual({ migrated: false, reason: 'already-migrated' })
  })
})
