export const LUMI_CLIENT_MIGRATION_FORMAT = 'lumi-client-migration:v1'

export interface LumiClientMigrationPackageV1 {
  format: typeof LUMI_CLIENT_MIGRATION_FORMAT
  version: 1
  packageId: string
  createdAt: string
  payloadSha256: string
  payload: {
    archive: Record<string, unknown>
    diaryEntries: unknown[]
  }
}

/**
 * Wraps a complete offline archive in the server's checksum-verified staging format.
 *
 * Use when:
 * - Moving an existing local Lumi into a newly initialized Lumi Server
 *
 * Expects:
 * - `archive` is a complete `lumi-data-archive:v6` object
 * - Diary attachments contain no active authentication tokens
 *
 * Returns:
 * - A package suitable for Server Manager staging, never direct database overwrite
 */
export async function createLumiClientMigrationPackage(
  archive: Record<string, unknown>,
  diaryEntries: unknown[] = [],
): Promise<LumiClientMigrationPackageV1> {
  const payload = { archive, diaryEntries }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)))
  return {
    format: LUMI_CLIENT_MIGRATION_FORMAT,
    version: 1,
    packageId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    payloadSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    payload,
  }
}
