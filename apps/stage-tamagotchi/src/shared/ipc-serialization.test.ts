import { describe, expect, it } from 'vitest'

import { cloneIpcRecord, cloneIpcValue } from './ipc-serialization'

describe('server manager IPC serialization', () => {
  it('removes proxies and undefined properties from nested configuration', () => {
    const providerOptions = new Proxy({ region: 'us-east-1', skipped: undefined }, {})
    const result = cloneIpcValue({ modelProviderOptions: providerOptions })
    expect(result).toEqual({ modelProviderOptions: { region: 'us-east-1' } })
    expect(() => structuredClone(result)).not.toThrow()
  })

  it('rejects non-record values at record boundaries', () => {
    expect(cloneIpcRecord(['invalid'])).toEqual({})
    expect(cloneIpcRecord({ enabled: true })).toEqual({ enabled: true })
  })
})
