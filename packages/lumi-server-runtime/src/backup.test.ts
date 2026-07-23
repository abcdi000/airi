import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { restoreLumiServerBackup, verifyLumiServerBackup, writeLumiServerBackup } from './backup'
import { DOGGY_PERSON_ID, LumiServerDatabase } from './database'

describe('lumi Server backup', () => {
  it('verifies and restores content without carrying active sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-server-backup-'))
    const source = LumiServerDatabase.open(':memory:')
    const restored = LumiServerDatabase.open(':memory:')
    try {
      source.acceptUserMessage({
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'backup-message',
        idempotencyKey: 'backup-message-key',
        content: 'Preserve me.',
        createdAt: Date.now(),
      })
      const written = await writeLumiServerBackup(source, directory)
      const verified = await verifyLumiServerBackup(written.manifestPath)
      await restoreLumiServerBackup(restored, written.manifestPath)

      expect(verified.manifest.sectionCounts.messages).toBe(1)
      expect(verified.backup.sections).not.toHaveProperty('sessions')
      expect(restored.replay(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 0).messages[0].content).toBe('Preserve me.')
    }
    finally {
      source.close()
      restored.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
