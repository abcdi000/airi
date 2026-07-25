export type LegacySourceMode = 'fresh' | 'recover'

/**
 * Decodes a value stored in the profile metadata table.
 *
 * Use when:
 * - Reading JSON values written by the profile metadata persistence boundary
 * - Normalizing legacy values before they enter an Electron IPC snapshot
 *
 * Expects:
 * - `valueJson` is either JSON text or absent
 *
 * Returns:
 * - The decoded value, or the supplied fallback when decoding fails
 */
export function decodeProfileMeta<T>(valueJson: unknown, fallback: T): T {
  if (typeof valueJson !== 'string')
    return fallback

  try {
    return JSON.parse(valueJson) as T
  }
  catch {
    return fallback
  }
}

/**
 * Normalizes the legacy profile import mode.
 *
 * Before:
 * - `"recover"`
 * - `"\"recover\""` (metadata affected by the historical double-encoding bug)
 *
 * After:
 * - `"recover"`
 */
export function normalizeLegacySourceMode(value: unknown, fallback: LegacySourceMode): LegacySourceMode {
  let current = value
  for (let depth = 0; depth < 16; depth += 1) {
    if (current === 'fresh' || current === 'recover')
      return current
    if (typeof current !== 'string')
      return fallback

    try {
      current = JSON.parse(current)
    }
    catch {
      return fallback
    }
  }
  return fallback
}
