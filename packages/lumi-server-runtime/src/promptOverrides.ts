import type {
  LumiPromptTemplate,
  LumiPromptTemplateId,
} from '@proj-airi/lumi-agent-runtime'

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  createLumiPromptTemplate,
  DEFAULT_LUMI_PROMPT_VERSIONS,
} from '@proj-airi/lumi-agent-runtime'

const PROMPT_IDS = Object.keys(DEFAULT_LUMI_PROMPT_VERSIONS) as LumiPromptTemplateId[]

/**
 * Loads optional host-owned prompt overrides without importing executable code.
 *
 * Use when:
 * - Lumi Server starts with `agentRuntime.promptDirectory`
 *
 * Expects:
 * - UTF-8 files named `<prompt-id>.txt`
 *
 * Returns:
 * - Only valid, non-empty overrides; missing files retain built-in defaults
 */
export async function loadLumiPromptOverrides(
  directory?: string,
): Promise<Partial<Record<LumiPromptTemplateId, LumiPromptTemplate>>> {
  if (!directory)
    return {}
  const root = resolve(directory)
  const entries = await Promise.all(PROMPT_IDS.map(async (id) => {
    try {
      const content = (await readFile(join(root, `${id}.txt`), 'utf8')).trim()
      if (!content)
        throw new Error(`Prompt override ${id}.txt is empty`)
      const template = createLumiPromptTemplate(id, content)
      return [id, {
        ...template,
        version: `override:${template.hash}`,
      }] as const
    }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : ''
      if (code === 'ENOENT')
        return undefined
      throw error
    }
  }))
  return Object.fromEntries(entries.filter(entry => entry !== undefined))
}
