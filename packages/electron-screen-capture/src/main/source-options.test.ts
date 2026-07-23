import { describe, expect, it } from 'vitest'

import { sourceLookupOptions } from './source-options'
import { windowHandleFromSourceId } from './windows-window-capture'

/** @example describe('sourceLookupOptions', () => {}) */
describe('sourceLookupOptions', () => {
  /** @example expect(result.types).toEqual(['window']) */
  it('looks up only the selected window without generating thumbnails for a media stream', () => {
    // ROOT CAUSE:
    //
    // Enumerating screen and window thumbnails makes Chromium instantiate WGC
    // capture items for unrelated invalid HWNDs before it reaches the selected
    // source. A zero thumbnail size keeps source discovery metadata-only.
    const result = sourceLookupOptions({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: { width: 1920, height: 1080 },
    }, 'window:123:0', false)

    expect(result.types).toEqual(['window'])
    expect(result.fetchWindowIcons).toBe(true)
    expect(result.thumbnailSize).toEqual({ width: 0, height: 0 })
  })

  /** @example expect(result.types).toEqual(['screen']) */
  it('uses a real thumbnail size for a selected screen still capture', () => {
    const result = sourceLookupOptions({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    }, 'screen:0:0', true)

    expect(result.types).toEqual(['screen'])
    expect(result.thumbnailSize).toEqual({ width: 1920, height: 1080 })
  })

  /** @example expect(result.types).toEqual(['screen']) */
  it('defaults an unspecified still capture to the first screen', () => {
    const result = sourceLookupOptions({ types: ['screen', 'window'] }, undefined, true)

    expect(result.types).toEqual(['screen'])
    expect(result.thumbnailSize).toEqual({ width: 1920, height: 1080 })
  })
})

/** @example describe('windowHandleFromSourceId', () => {}) */
describe('windowHandleFromSourceId', () => {
  /** @example expect(windowHandleFromSourceId('window:123:0')).toBe('123') */
  it('extracts only a positive decimal HWND from an Electron window source ID', () => {
    expect(windowHandleFromSourceId('window:123456:0')).toBe('123456')
    expect(windowHandleFromSourceId('screen:123456:0')).toBeUndefined()
    expect(windowHandleFromSourceId('window:0:0')).toBeUndefined()
    expect(windowHandleFromSourceId('window:not-a-handle:0')).toBeUndefined()
  })
})
