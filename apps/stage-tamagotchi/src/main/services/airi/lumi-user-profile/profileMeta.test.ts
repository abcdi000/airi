import { describe, expect, it } from 'vitest'

import { decodeProfileMeta, normalizeLegacySourceMode } from './profileMeta'

describe('profile metadata codec', () => {
  /**
   * @example
   * A persisted JSON string is decoded exactly once at the database boundary.
   */
  it('decodes stored JSON values before they are written again', () => {
    expect(decodeProfileMeta(JSON.stringify('recover'), 'fresh')).toBe('recover')
    expect(decodeProfileMeta(JSON.stringify(true), false)).toBe(true)
  })

  /**
   * @example
   * A mode damaged by repeated startup encoding is reduced to its domain value.
   */
  it('repairs recursively encoded legacy source modes', () => {
    const encodedTwice = JSON.stringify(JSON.stringify('recover'))
    const encodedThreeTimes = JSON.stringify(encodedTwice)

    expect(normalizeLegacySourceMode(encodedTwice, 'fresh')).toBe('recover')
    expect(normalizeLegacySourceMode(encodedThreeTimes, 'fresh')).toBe('recover')
  })

  /**
   * @example
   * Invalid metadata falls back to the mode selected from database existence.
   */
  it('uses the supplied fallback for invalid source modes', () => {
    expect(normalizeLegacySourceMode('invalid', 'recover')).toBe('recover')
    expect(normalizeLegacySourceMode(undefined, 'fresh')).toBe('fresh')
  })
})
