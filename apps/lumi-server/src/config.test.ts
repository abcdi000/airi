import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { initializeLumiServerConfig, loadLumiServerConfig, upgradeLumiServerConfig } from './config'

describe('lumi Server process configuration', () => {
  it('creates one private config and resolves its data directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-server-config-'))
    const path = join(directory, 'config', 'server.json')
    try {
      await initializeLumiServerConfig(path)
      const config = await loadLumiServerConfig(path)
      expect(config.authSecret.length).toBeGreaterThanOrEqual(32)
      expect(config.dataDirectory).toBe(join(directory, 'config', 'data'))
      expect(config.languageLearning).toMatchObject({
        enabled: true,
        directLanguageCandidateLearningEnabled: false,
        groupExpressionLearningEnabled: true,
        groupJargonLearningEnabled: true,
        groupBehaviorLearningEnabled: true,
        groupPublicKnowledgeLearningEnabled: true,
        maxSelectedExpressions: 3,
        preciseSelectorEnabled: true,
        promptLoggingEnabled: false,
      })
      expect(config.model).toMatchObject({
        maxContextTokens: 1_000_000,
        outputReserveTokens: 64_000,
        promptReserveTokens: 32_000,
      })
      expect(config.agentRuntime).toMatchObject({
        promptDirectory: join(directory, 'config', 'prompts'),
        mode: 'maisaka',
        plannerMaxRounds: 10,
        plannerFinalizationMode: 'stop_after_successful_reply',
        toolMaxConcurrency: 4,
        deferredToolsEnabled: true,
        expressionSelectorEnabled: true,
        directLanguageFeedbackEnabled: true,
        promptLoggingEnabled: false,
      })
      expect(config.astrbot).toMatchObject({
        privateReplyEnabled: true,
        groupObservationEnabled: false,
      })
      expect(JSON.parse(await readFile(path, 'utf8'))).not.toHaveProperty('airiAccount')
      await expect(initializeLumiServerConfig(path)).rejects.toMatchObject({ code: 'EEXIST' })
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('defaults old Sub2API configuration to auto protocol without changing other providers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-server-sub2api-config-'))
    const path = join(directory, 'server.json')
    try {
      await initializeLumiServerConfig(path)
      const raw = JSON.parse(await readFile(path, 'utf8'))
      raw.model.providerId = 'sub2api'
      raw.model.baseURL = 'http://127.0.0.1:8080/v1/'
      raw.model.model = 'model-from-server'
      raw.model.providerOptions = {}
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')

      await expect(loadLumiServerConfig(path)).resolves.toMatchObject({
        model: {
          providerId: 'sub2api',
          providerOptions: {
            protocol: 'auto',
            reasoningEffort: 'auto',
          },
        },
      })

      raw.model.providerOptions = { protocol: 'invalid' }
      await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
      await expect(loadLumiServerConfig(path)).rejects.toThrow()
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('adds an AstrBot token to a config created before the integration existed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-server-config-upgrade-'))
    const path = join(directory, 'server.json')
    try {
      await initializeLumiServerConfig(path)
      const legacy = JSON.parse(await readFile(path, 'utf8'))
      delete legacy.astrbot
      delete legacy.languageLearning
      delete legacy.agentRuntime
      await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

      await expect(upgradeLumiServerConfig(path)).resolves.toBe(true)
      await expect(upgradeLumiServerConfig(path)).resolves.toBe(false)

      const upgraded = JSON.parse(await readFile(path, 'utf8'))
      expect(upgraded.astrbot.enabled).toBe(false)
      expect(upgraded.astrbot.apiToken.length).toBeGreaterThanOrEqual(32)
      expect(upgraded.astrbot.privateReplyEnabled).toBe(true)
      expect(upgraded.astrbot.groupObservationEnabled).toBe(false)
      expect(upgraded.astrbot).not.toHaveProperty('learningMode')
      expect(upgraded.astrbot.identityBindings).toHaveLength(6)
      expect(upgraded.languageLearning).toMatchObject({
        enabled: true,
        directLanguageCandidateLearningEnabled: false,
        groupExpressionLearningEnabled: true,
        groupJargonLearningEnabled: true,
        groupBehaviorLearningEnabled: true,
        groupPublicKnowledgeLearningEnabled: true,
        multiMessageReplyEnabled: true,
        preciseSelectorEnabled: true,
      })
      expect(upgraded.model).toMatchObject({
        maxContextTokens: 1_000_000,
        outputReserveTokens: 64_000,
        promptReserveTokens: 32_000,
      })
      expect(upgraded.agentRuntime).toMatchObject({
        promptDirectory: './prompts',
        mode: 'shadow',
        plannerMaxRounds: 10,
        plannerFinalizationMode: 'stop_after_successful_reply',
      })
      expect(upgraded.astrbot.identityBindings).toEqual(expect.arrayContaining([
        {
          platformInstanceId: 'default',
          externalUserId: '1770249418',
          personId: 'lumi-user-00000000-0000-4000-8000-000000000001',
        },
        {
          platformInstanceId: 'default',
          externalUserId: '1428755063',
          personId: 'lumi-user-00000000-0000-4000-8000-000000000002',
        },
      ]))
      await expect(loadLumiServerConfig(path)).resolves.toMatchObject({
        astrbot: { enabled: false },
      })
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('migrates legacy observe-only policy without preventing later dual enablement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-server-policy-upgrade-'))
    const path = join(directory, 'server.json')
    try {
      await initializeLumiServerConfig(path)
      const legacy = JSON.parse(await readFile(path, 'utf8'))
      delete legacy.astrbot.privateReplyEnabled
      delete legacy.astrbot.groupObservationEnabled
      legacy.astrbot.learningMode = 'observe_only'
      await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')

      await expect(loadLumiServerConfig(path)).resolves.toMatchObject({
        astrbot: {
          privateReplyEnabled: false,
          groupObservationEnabled: true,
        },
      })
      await expect(upgradeLumiServerConfig(path)).resolves.toBe(true)

      const migrated = JSON.parse(await readFile(path, 'utf8'))
      expect(migrated.astrbot).toMatchObject({
        privateReplyEnabled: false,
        groupObservationEnabled: true,
      })
      expect(migrated.astrbot).not.toHaveProperty('learningMode')
      migrated.astrbot.privateReplyEnabled = true
      await writeFile(path, `${JSON.stringify(migrated, null, 2)}\n`, 'utf8')
      await expect(loadLumiServerConfig(path)).resolves.toMatchObject({
        astrbot: {
          privateReplyEnabled: true,
          groupObservationEnabled: true,
        },
      })
    }
    finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
