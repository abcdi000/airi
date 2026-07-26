import type {
  LumiConsciousnessModel,
  LumiServerDatabase,
  LumiServerGroupObservationRuntime,
} from '@proj-airi/lumi-server-runtime'

import type { LumiServerProcessConfig } from './config'

import process from 'node:process'

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import {
  buildLumiStickerClassificationMessages,
  buildLumiStickerSelectionMessages,
  createLumiNetworkServer,
  createLumiNodeConsciousness,
  createLumiServerGroupObservationRuntime,
  createOpenAICompatibleConsciousnessModel,
  createOpenAICompatibleTranscriber,
  createOpenAICompatibleVisionAnalyzer,
  LumiBackgroundLife,
  LumiServerJobWorker,
  LumiServerMcpRegistry,
  LumiServerMigrationService,
  LumiServerPluginRegistry,
  LumiServerVectorService,
  LumiStickerLibrary,
  LumiVectorWorker,
  parseLumiStickerClassification,
  parseLumiStickerSelection,
  writeLumiServerBackup,
} from '@proj-airi/lumi-server-runtime'

/** Starts the standalone server from an already validated configuration. */
export async function startLumiServerProcess(config: LumiServerProcessConfig) {
  const mcp = new LumiServerMcpRegistry(config.serverVersion)
  await mcp.apply(config.mcp)
  const plugins = new LumiServerPluginRegistry()
  await plugins.apply(config.plugins)
  let stickerIntelligenceModel: LumiConsciousnessModel | undefined
  const stickerLibrary = config.astrbot?.stickerLibrary
    ? new LumiStickerLibrary(
        () => config.astrbot!.stickerLibrary!,
        () => config.dataDirectory,
        {
          async classify(input) {
            if (!stickerIntelligenceModel)
              throw new Error('Lumi consciousness model is not ready for sticker learning')
            const raw = await stickerIntelligenceModel.generateLanguageText(
              buildLumiStickerClassificationMessages(input),
              'sticker_classifier',
            )
            const parsed = parseLumiStickerClassification(raw)
            if (!parsed)
              throw new Error('Lumi consciousness returned an invalid sticker classification')
            return parsed
          },
          async select(input) {
            if (!stickerIntelligenceModel)
              throw new Error('Lumi consciousness model is not ready for sticker selection')
            const raw = await stickerIntelligenceModel.generateLanguageText(
              buildLumiStickerSelectionMessages(input),
              'sticker_selector',
            )
            const parsed = parseLumiStickerSelection(raw)
            if (!parsed)
              throw new Error('Lumi consciousness returned an invalid sticker selection')
            return parsed
          },
        },
      )
    : undefined
  const tls = config.tls
    ? {
        cert: await readFile(config.tls.certPath, 'utf8'),
        key: await readFile(config.tls.keyPath, 'utf8'),
        passphrase: config.tls.passphrase,
      }
    : undefined
  let vectorService: LumiServerVectorService | undefined
  let jobWorker: LumiServerJobWorker | undefined
  let databaseRef: LumiServerDatabase | undefined
  let migrationService: LumiServerMigrationService | undefined
  let groupObservationRuntime: LumiServerGroupObservationRuntime | undefined
  let server: Awaited<ReturnType<typeof createLumiNetworkServer>> | undefined
  try {
    server = await createLumiNetworkServer({
      databasePath: join(config.dataDirectory, 'lumi-server.sqlite3'),
      authSecret: config.authSecret,
      publicBaseURL: config.publicBaseURL,
      hostname: config.hostname,
      port: config.port,
      trustedOrigins: config.trustedOrigins,
      serverVersion: config.serverVersion,
      voiceTranscriber: config.transcription?.enabled
        ? createOpenAICompatibleTranscriber(config.transcription)
        : undefined,
      maxVoiceBytes: config.transcription?.maxVoiceBytes,
      astrbot: config.astrbot?.enabled
        ? {
            apiToken: config.astrbot.apiToken,
            identityBindings: config.astrbot.identityBindings,
            visionAnalyzer: config.vision?.enabled
              ? createOpenAICompatibleVisionAnalyzer(config.vision)
              : undefined,
            maxImageBytes: config.astrbot.maxImageBytes,
            maxAudioBytes: config.astrbot.maxAudioBytes,
            responseTimeoutMs: config.astrbot.responseTimeoutMs,
            maxRequestBytes: config.astrbot.maxRequestBytes,
            privateReplyEnabled: config.astrbot.privateReplyEnabled,
            groupObservationEnabled: config.astrbot.groupObservationEnabled,
            studyGroups: config.astrbot.studyGroups,
            observationBatchSize: config.astrbot.observationBatchSize,
            stickerLibrary,
            observeGroup: async (input) => {
              if (!groupObservationRuntime)
                throw new Error('Lumi group observation runtime is not ready')
              return await groupObservationRuntime.observe(input)
            },
          }
        : undefined,
      onGenerationError(error, context) {
        console.error(
          `[generation] conversation=${context.conversation.id} input=${context.input.id}: ${error.stack ?? error.message}`,
        )
      },
      manager: {
        ...config.manager,
        toolControl: mcp,
        pluginControl: plugins,
        dataControl: {
          vectorStatus: () => vectorService ? { enabled: true, ...vectorService.status() } : { enabled: false },
          enqueueVectorBackfill: () => {
            if (!databaseRef || !vectorService)
              throw new Error('Server vector service is disabled')
            const job = databaseRef.enqueueJobIfIdle('memory-vector-backfill')
            return job ? { status: 'queued', jobId: job.id } : { status: 'already-active' }
          },
          stageMigration: async migration => ({ ...(await requiredMigrationService(migrationService).stage(migration)) }),
          commitMigration: async migrationId => ({ imported: await requiredMigrationService(migrationService).commit(migrationId) }),
          createBackup: async () => {
            if (!databaseRef)
              throw new Error('Server database is not ready')
            return await writeLumiServerBackup(databaseRef, join(config.dataDirectory, 'backups'))
          },
        },
      },
      tls,
      createReplyGenerator(database) {
        databaseRef = database
        migrationService = new LumiServerMigrationService(database, join(config.dataDirectory, 'migration-staging'))
        const model = createOpenAICompatibleConsciousnessModel({
          ...config.model,
          toolProvider: {
            toolsFor: async request => [
              ...await mcp.toolsFor(request),
              ...await plugins.toolsFor(request),
            ],
          },
        })
        stickerIntelligenceModel = model
        if (config.astrbot?.enabled) {
          groupObservationRuntime = createLumiServerGroupObservationRuntime({
            database,
            model,
            enabled: config.astrbot.groupObservationEnabled,
            batchSize: config.astrbot.observationBatchSize,
            studyGroups: config.astrbot.studyGroups.map(group => ({
              sourceId: group.id,
              platformInstanceId: group.platformInstanceId,
              groupId: group.groupId,
              enabled: group.enabled,
            })),
            languageLearning: config.languageLearning,
          })
          void groupObservationRuntime.resume().catch((error) => {
            console.error('[group-observation] Failed to resume persisted learning batches', error)
          })
        }
        const backgroundLife = new LumiBackgroundLife({
          database,
          model,
          personaPrompt: config.personaPrompt,
          diary: config.background.diary,
          autonomousLife: config.background.autonomousLife,
        })
        if (config.vector.enabled) {
          vectorService = createVectorService(config, database)
          jobWorker = new LumiServerJobWorker({
            database,
            handlers: {
              'memory-vector-backfill': async () => ({ ...(await vectorService!.backfill()) }),
              ...backgroundLife.handlers(),
            },
          })
          database.enqueueJobIfIdle('memory-vector-backfill')
          jobWorker.start()
        }
        else {
          jobWorker = new LumiServerJobWorker({ database, handlers: backgroundLife.handlers() })
          jobWorker.start()
        }
        backgroundLife.scheduleInitialJobs()
        return createLumiNodeConsciousness({
          database,
          personaPrompt: config.personaPrompt,
          maxContextTokens: config.model.maxContextTokens,
          outputReserveTokens: config.model.outputReserveTokens,
          promptReserveTokens: config.model.promptReserveTokens,
          languageLearningConfig: config.languageLearning,
          semanticMemorySearch: vectorService
            ? (request, limit) => vectorService!.search(request, limit)
            : undefined,
          socialLanguageEmbedding: vectorService
            ? texts => vectorService!.embedSocialLanguage(texts)
            : undefined,
          model,
        })
      },
      async beforeDatabaseClose() {
        await groupObservationRuntime?.drain()
        await jobWorker?.stop()
        await vectorService?.stop()
      },
    })
    await server.start()
    const runningServer = server
    return {
      ...runningServer,
      async stop() {
        await runningServer.stop()
        await mcp.stopAll()
      },
    }
  }
  catch (error) {
    await server?.stop()
    await mcp.stopAll()
    throw error
  }
}

function requiredMigrationService(service: LumiServerMigrationService | undefined) {
  if (!service)
    throw new Error('Server migration service is not ready')
  return service
}

function createVectorService(config: LumiServerProcessConfig, database: Parameters<typeof createLumiNodeConsciousness>[0]['database']) {
  const runtime = resolveVectorRuntime(config)
  return new LumiServerVectorService(database, new LumiVectorWorker({
    workerScriptPath: runtime.workerScriptPath,
    pythonCommand: runtime.pythonCommand,
    pythonArguments: config.vector.pythonArguments,
    modelCacheRoot: config.vector.modelCacheRoot ?? join(config.dataDirectory, 'lumi-vector-model-cache'),
    bundledModelCacheRoot: config.vector.bundledModelCacheRoot ?? runtime.bundledModelCacheRoot,
    model: config.vector.model,
    device: config.vector.device,
  }))
}

function resolveVectorRuntime(config: LumiServerProcessConfig) {
  const executableRoot = dirname(process.execPath)
  const resourceRoots = uniquePaths([
    join(executableRoot, 'resources'),
    executableRoot,
    ...ancestorPaths(executableRoot),
    process.cwd(),
    ...ancestorPaths(process.cwd()),
  ])
  const workerScriptPath = config.vector.workerScriptPath ?? firstExisting(
    resourceRoots.map(root => join(root, 'services', 'lumi-memory-vector', 'server.py')),
  )
  if (!workerScriptPath)
    throw new Error('Lumi Server vector worker script was not found; configure vector.workerScriptPath')

  const bundledPython = process.platform === 'win32'
    ? firstExisting(resourceRoots.flatMap(root => [
        join(root, 'python', 'python.exe'),
        join(root, 'python', 'Scripts', 'python.exe'),
        join(root, 'apps', 'stage-tamagotchi', 'resources', 'python', 'python.exe'),
      ]))
    : firstExisting(resourceRoots.flatMap(root => [join(root, 'python', 'bin', 'python3'), join(root, 'python', 'bin', 'python')]))
  const pythonCommand = config.vector.pythonPath
    ?? process.env.LUMI_MEMORY_VECTOR_PYTHON
    ?? bundledPython
    ?? (process.platform === 'win32' ? 'python.exe' : 'python3')
  const bundledModelCacheRoot = firstExisting(resourceRoots.flatMap(root => [
    join(root, 'vector-model-cache'),
    join(root, 'apps', 'stage-tamagotchi', 'resources', 'vector-model-cache'),
  ]))
  return { workerScriptPath, pythonCommand, bundledModelCacheRoot }
}

function ancestorPaths(start: string) {
  const paths: string[] = []
  let current = resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    paths.push(current)
    const parent = dirname(current)
    if (parent === current)
      break
    current = parent
  }
  return paths
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.map(path => resolve(path)))]
}

function firstExisting(paths: string[]) {
  return paths.find(path => existsSync(path))
}
