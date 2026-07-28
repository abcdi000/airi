import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadLumiPromptOverrides } from './promptOverrides'

describe('lumi Server prompt overrides', () => {
  it('loads only configured UTF-8 templates and assigns content-derived versions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-prompts-'))
    try {
      await writeFile(join(directory, 'planner.txt'), 'Custom planner contract\n', 'utf8')

      const overrides = await loadLumiPromptOverrides(directory)

      expect(overrides.planner).toMatchObject({
        id: 'planner',
        content: 'Custom planner contract',
      })
      expect(overrides.planner?.version).toBe(`override:${overrides.planner?.hash}`)
      expect(overrides.replyer).toBeUndefined()
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns built-in fallback selection when the configured directory is empty', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-prompts-empty-'))
    try {
      await mkdir(join(directory, 'nested'))

      await expect(loadLumiPromptOverrides(directory)).resolves.toEqual({})
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
