// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'

import {
  deserializeBackgroundEntries,
  exportLumiLocalStorageSnapshot,
  isLumiDataArchivePayload,
  LUMI_DATA_ARCHIVE_FORMAT,
  LUMI_DATA_ARCHIVE_FORMAT_V1,
  LUMI_DATA_ARCHIVE_FORMAT_V2,
  LUMI_DATA_ARCHIVE_FORMAT_V3,
  LUMI_DATA_ARCHIVE_FORMAT_V4,
  LUMI_DATA_ARCHIVE_FORMAT_V5,
  restoreLumiLocalStorageSnapshot,
  serializeBackgroundEntries,
} from './lumi-archive'

afterEach(() => {
  localStorage.clear()
})

describe('lumi data archive helpers', () => {
  it('filters localStorage restore to the Lumi archive allowlist', () => {
    localStorage.setItem('settings/plugins/lumi-proactive-vision/private-notes', '[]')

    const snapshot = exportLumiLocalStorageSnapshot([
      'settings/plugins/lumi-proactive-vision/private-notes',
      'settings/plugins/lumi-proactive-vision/self-todo',
    ])

    expect(snapshot).toEqual({
      'settings/plugins/lumi-proactive-vision/private-notes': '[]',
    })

    restoreLumiLocalStorageSnapshot({
      'settings/plugins/lumi-proactive-vision/private-notes': '[{"note":"kept"}]',
      'unrelated/provider/api-key': 'must-not-import',
    }, ['settings/plugins/lumi-proactive-vision/private-notes'])

    expect(localStorage.getItem('settings/plugins/lumi-proactive-vision/private-notes')).toBe('[{"note":"kept"}]')
    expect(localStorage.getItem('unrelated/provider/api-key')).toBeNull()
  })

  it('round-trips user background blobs without exporting builtins', async () => {
    const entries = await serializeBackgroundEntries([
      {
        id: 'builtin:cozy',
        type: 'builtin',
        characterId: null,
        title: 'Builtin',
        blob: new Blob(['builtin'], { type: 'text/plain' }),
        createdAt: 1,
      },
      {
        id: 'bg-journal',
        type: 'journal',
        characterId: 'lumi',
        title: 'Journal image',
        prompt: 'a quiet desk',
        blob: new Blob(['hello lumi'], { type: 'text/plain' }),
        createdAt: 2,
      },
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('bg-journal')

    const restored = await deserializeBackgroundEntries(entries)

    expect(restored).toHaveLength(1)
    expect(restored[0]?.type).toBe('journal')
    expect(await restored[0]?.blob.text()).toBe('hello lumi')
  })

  it('recognizes the versioned Lumi archive envelope', () => {
    expect(isLumiDataArchivePayload({
      format: LUMI_DATA_ARCHIVE_FORMAT,
      version: 6,
      sections: {},
    })).toBe(true)

    expect(isLumiDataArchivePayload({
      format: LUMI_DATA_ARCHIVE_FORMAT_V5,
      version: 5,
      sections: {},
    })).toBe(true)

    expect(isLumiDataArchivePayload({
      format: LUMI_DATA_ARCHIVE_FORMAT_V4,
      version: 4,
      sections: {},
    })).toBe(true)

    expect(isLumiDataArchivePayload({
      format: LUMI_DATA_ARCHIVE_FORMAT_V3,
      version: 3,
      sections: {},
    })).toBe(true)

    expect(isLumiDataArchivePayload({
      format: LUMI_DATA_ARCHIVE_FORMAT_V2,
      version: 2,
      sections: {},
    })).toBe(true)

    expect(isLumiDataArchivePayload({
      format: LUMI_DATA_ARCHIVE_FORMAT_V1,
      version: 1,
      sections: {},
    })).toBe(true)

    expect(isLumiDataArchivePayload({
      format: 'chat-sessions-index:v1',
      version: 1,
      sections: {},
    })).toBe(false)
  })
})
