import type { Tool } from '@xsai/shared-chat'

import type { LumiConsciousnessRequest } from './consciousness'
import type { LumiServerToolProvider } from './openAICompatibleModel'

import { readdir, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { errorMessageFrom } from '@moeru/std'

export interface LumiServerPluginConfig {
  directory?: string
  enabled: string[]
  settings?: Record<string, Record<string, unknown>>
}

export interface LumiServerPluginStatus {
  name: string
  state: 'disabled' | 'loaded' | 'error' | 'incompatible'
  toolCount: number
  path: string
  lastError?: string
}

interface RegisteredPluginTool {
  id: string
  title?: string
  description?: string
  parameters?: Record<string, unknown>
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown
}

interface PluginManifest {
  name: string
  entrypoints?: { server?: string, default?: string }
}

/** Loads explicitly enabled, server-compatible Lumi plugins and exposes their tools. */
export class LumiServerPluginRegistry implements LumiServerToolProvider {
  private readonly tools = new Map<string, RegisteredPluginTool>()
  private statuses: LumiServerPluginStatus[] = []

  async apply(config: LumiServerPluginConfig): Promise<void> {
    this.tools.clear()
    this.statuses = []
    if (!config.directory)
      return
    const root = resolve(config.directory)
    const enabled = new Set(config.enabled)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory())
        continue
      const manifestPath = join(root, entry.name, 'plugin.airi.json')
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest
        if (!manifest.name)
          continue
        const entrypoint = manifest.entrypoints?.server ?? manifest.entrypoints?.default
        if (!entrypoint) {
          this.statuses.push({ name: manifest.name, state: 'incompatible', toolCount: 0, path: manifestPath })
          continue
        }
        if (!enabled.has(manifest.name)) {
          this.statuses.push({ name: manifest.name, state: 'disabled', toolCount: 0, path: manifestPath })
          continue
        }
        const before = this.tools.size
        const entrypointPath = isAbsolute(entrypoint) ? entrypoint : resolve(dirname(manifestPath), entrypoint)
        const module = await import(`${pathToFileURL(entrypointPath).href}?server=${Date.now()}`) as {
          init?: (context?: unknown) => Promise<void> | void
          setupModules?: (context: unknown) => Promise<void> | void
        }
        const pluginContext = {
          config: config.settings?.[manifest.name] ?? {},
          apis: {
            tools: {
              register: async (registration: { tool: Omit<RegisteredPluginTool, 'execute'>, execute: RegisteredPluginTool['execute'] }) => {
                this.tools.set(registration.tool.id, { ...registration.tool, execute: registration.execute })
              },
              registerToolsetPrompt: async () => {},
            },
          },
        }
        await module.init?.(pluginContext)
        await module.setupModules?.(pluginContext)
        this.statuses.push({ name: manifest.name, state: 'loaded', toolCount: this.tools.size - before, path: manifestPath })
      }
      catch (error) {
        this.statuses.push({
          name: entry.name,
          state: 'error',
          toolCount: 0,
          path: manifestPath,
          lastError: errorMessageFrom(error) ?? 'Plugin load failed',
        })
      }
    }
  }

  statusesSnapshot() {
    return structuredClone(this.statuses)
  }

  async toolsFor(_request: LumiConsciousnessRequest): Promise<Tool[]> {
    return [...this.tools.values()].map(tool => ({
      type: 'function',
      function: {
        name: normalizeToolName(tool.id),
        description: tool.description ?? tool.title ?? tool.id,
        parameters: tool.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
        strict: false,
      },
      execute: async input => await tool.execute(record(input)),
    }))
  }
}

/**
 * Normalizes a plugin tool identifier for OpenAI-compatible tool calling.
 *
 * Before:
 * - "Lumi Diary::write entry"
 *
 * After:
 * - "plugin_lumi_diary_write_entry"
 */
function normalizeToolName(value: string) {
  return `plugin_${value}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
