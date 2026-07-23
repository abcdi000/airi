import { describe, expect, it } from 'vitest'

import { createLumiClientMigrationPackage } from './lumi-migration'

describe('createLumiClientMigrationPackage', () => {
  it('creates a checksum accepted by the server migration envelope', async () => {
    const archive = { format: 'lumi-data-archive:v6', version: 6, sections: {} }
    const result = await createLumiClientMigrationPackage(archive)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(result.payload)))
    const expected = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')

    expect(result.format).toBe('lumi-client-migration:v1')
    expect(result.payload.archive).toEqual(archive)
    expect(result.payloadSha256).toBe(expected)
  })

  it('includes every supplied file-backed diary entry in the checksummed payload', async () => {
    const archive = { format: 'lumi-data-archive:v6', version: 6, sections: {} }
    const diaries = [{ id: 'legacy-diary:2026-07-22', entryDate: '2026-07-22', content: 'Today.' }]
    const result = await createLumiClientMigrationPackage(archive, diaries)

    expect(result.payload.diaryEntries).toEqual(diaries)
  })
})
