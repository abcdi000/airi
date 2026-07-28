import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { errorMessageFrom } from '@moeru/std'
import { LumiServerDatabase, LumiServerMcpRegistry, restoreLumiServerBackup, writeLumiServerBackup } from '@proj-airi/lumi-server-runtime'
import { initializeLumiServerConfig, loadLumiServerConfig, upgradeLumiServerConfig } from '@proj-airi/lumi-server/config'
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'

import icon from '../../../resources/icon.png?asset'

import { cloneIpcRecord, cloneIpcValue } from '../../shared/ipc-serialization'
import { baseUrl, getElectronMainDirname, load } from '../libs/electron/location'
import { getDeepSeekBalance, listProviderModels, testProviderAccess, testProviderConnection } from './provider-control'

export interface LumiServerManagerState {
  processState: 'stopped' | 'starting' | 'running' | 'stopping' | 'error'
  pid?: number
  error?: string
  configPath: string
  autoStart: boolean
  logs: string[]
  config: {
    publicBaseURL: string
    hostname: string
    port: number
    model: {
      providerId: string
      baseURL: string
      model: string
      apiKeySet: boolean
      temperature?: number
      maxOutputTokens?: number
      maxContextTokens: number
      outputReserveTokens: number
      promptReserveTokens: number
      maxSteps: number
      thinkingMode: 'auto' | 'enabled' | 'disabled'
      reasoningEffort: 'auto' | 'high' | 'max'
      providerOptions: Record<string, unknown>
    }
    agentRuntime: {
      promptDirectory?: string
      mode: 'legacy' | 'shadow' | 'maisaka'
      plannerMaxRounds: number
      plannerFinalizationMode: 'maibot' | 'stop_after_successful_reply'
      mergeWindowMs: number
      toolMaxConcurrency: number
      toolStepTimeoutMs: number
      deferredToolsEnabled: boolean
      expressionSelectorEnabled: boolean
      directLanguageFeedbackEnabled: boolean
      promptLoggingEnabled: boolean
      plannerHistoryBudgetTokens: number
      contextCompactionThresholdTokens: number
      contextRecentTokens: number
    }
    languageLearning: {
      directLanguageCandidateLearningEnabled: boolean
      groupExpressionLearningEnabled: boolean
      groupJargonLearningEnabled: boolean
      groupBehaviorLearningEnabled: boolean
      groupPublicKnowledgeLearningEnabled: boolean
    }
    vector: { enabled: boolean, model: string, device: string }
    transcription: { providerId: string, enabled: boolean, baseURL: string, model: string, language?: string, prompt?: string, maxVoiceBytes: number, apiKeySet: boolean }
    tls: { enabled: boolean, certPath?: string, keyPath?: string }
    trustedOrigins: string[]
    mcp: Record<string, unknown>
    plugins: { directory?: string, enabled: string[], settings: Record<string, Record<string, unknown>> }
    background: Record<string, unknown>
    astrbot: {
      enabled: boolean
      tokenConfigured: boolean
      privateReplyEnabled: boolean
      groupObservationEnabled: boolean
      studyGroups: Array<{
        id: string
        platformInstanceId: string
        groupId: string
        displayName: string
        enabled: boolean
        priority: 'normal' | 'high'
      }>
      observationBatchSize: number
      stickerLibrary: {
        enabled: boolean
        collectFromStudyGroups: boolean
        relativePath: string
        maximumItems: number
        sendProbability: number
        cooldownMessages: number
      }
      identityBindings: Array<{
        platformInstanceId: string
        externalUserId: string
        personId: string
      }>
    }
  }
}

/** Starts the local-only manager window and its independent Node server worker. */
export async function setupLumiServerManager() {
  const configPath = join(app.getPath('userData'), 'lumi-server.json')
  if (!existsSync(configPath))
    await initializeLumiServerConfig(configPath)
  await upgradeLumiServerConfig(configPath)
  await importLegacyMcpConfig(configPath)
  await normalizeLegacyMcpRuntimePaths(configPath)
  await ensureServerPluginDefaults(configPath)
  let child: ChildProcessWithoutNullStreams | undefined
  let processState: LumiServerManagerState['processState'] = 'stopped'
  let lastError: string | undefined
  const logs: string[] = []
  const window = new BrowserWindow({
    title: 'Lumi Server Manager',
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    icon,
    webPreferences: {
      preload: join(dirname(getElectronMainDirname()), 'preload', 'index.mjs'),
      sandbox: false,
    },
  })

  const assertSender = (senderId: number) => {
    if (senderId !== window.webContents.id)
      throw new Error('Unauthorized Server Manager renderer')
  }
  const state = async (): Promise<LumiServerManagerState> => {
    const config = await loadLumiServerConfig(configPath)
    return {
      processState,
      pid: child?.pid,
      error: lastError,
      configPath,
      autoStart: app.getLoginItemSettings({ args: ['--lumi-server-manager', '--start-server'] }).openAtLogin,
      logs: [...logs],
      config: {
        publicBaseURL: config.publicBaseURL,
        hostname: config.hostname,
        port: config.port,
        model: {
          providerId: config.model.providerId,
          baseURL: config.model.baseURL,
          model: config.model.model,
          apiKeySet: Boolean(config.model.apiKey),
          temperature: config.model.temperature,
          maxOutputTokens: config.model.maxOutputTokens,
          maxContextTokens: config.model.maxContextTokens,
          outputReserveTokens: config.model.outputReserveTokens,
          promptReserveTokens: config.model.promptReserveTokens,
          maxSteps: config.model.maxSteps,
          thinkingMode: config.model.thinkingMode,
          reasoningEffort: config.model.reasoningEffort,
          providerOptions: config.model.providerOptions,
        },
        agentRuntime: { ...config.agentRuntime },
        languageLearning: {
          directLanguageCandidateLearningEnabled: config.languageLearning.directLanguageCandidateLearningEnabled,
          groupExpressionLearningEnabled: config.languageLearning.groupExpressionLearningEnabled,
          groupJargonLearningEnabled: config.languageLearning.groupJargonLearningEnabled,
          groupBehaviorLearningEnabled: config.languageLearning.groupBehaviorLearningEnabled,
          groupPublicKnowledgeLearningEnabled: config.languageLearning.groupPublicKnowledgeLearningEnabled,
        },
        vector: { enabled: config.vector.enabled, model: config.vector.model, device: config.vector.device },
        transcription: {
          providerId: config.transcription?.providerId ?? 'openai',
          enabled: config.transcription?.enabled ?? false,
          baseURL: config.transcription?.baseURL ?? 'https://api.openai.com/v1/',
          model: config.transcription?.model ?? 'whisper-1',
          language: config.transcription?.language,
          prompt: config.transcription?.prompt,
          maxVoiceBytes: config.transcription?.maxVoiceBytes ?? 25 * 1024 * 1024,
          apiKeySet: Boolean(config.transcription?.apiKey),
        },
        tls: { enabled: Boolean(config.tls), certPath: config.tls?.certPath, keyPath: config.tls?.keyPath },
        trustedOrigins: config.trustedOrigins,
        mcp: config.mcp,
        plugins: { ...config.plugins, settings: config.plugins.settings ?? {} },
        background: config.background,
        astrbot: {
          enabled: config.astrbot?.enabled ?? false,
          tokenConfigured: Boolean(config.astrbot?.apiToken),
          privateReplyEnabled: config.astrbot?.privateReplyEnabled ?? true,
          groupObservationEnabled: config.astrbot?.groupObservationEnabled ?? false,
          studyGroups: config.astrbot?.studyGroups ?? [],
          observationBatchSize: config.astrbot?.observationBatchSize ?? 20,
          stickerLibrary: config.astrbot?.stickerLibrary ?? {
            enabled: true,
            collectFromStudyGroups: true,
            relativePath: 'lumi-stickers',
            maximumItems: 256,
            sendProbability: 0.18,
            cooldownMessages: 3,
          },
          identityBindings: config.astrbot?.identityBindings ?? [],
        },
      },
    }
  }
  const appendLog = (line: string) => {
    for (const value of line.split(/\r?\n/).filter(Boolean))
      logs.push(`${new Date().toISOString()} ${value}`)
    logs.splice(0, Math.max(0, logs.length - 500))
    window.webContents.send('lumi-server-manager:changed')
  }

  async function start() {
    if (child && child.exitCode === null)
      return await state()
    processState = 'starting'
    lastError = undefined
    const workerPath = join(getElectronMainDirname(), 'lumi-server-worker.js')
    child = spawn(process.execPath, [workerPath, 'start', '--config', configPath], {
      cwd: dirname(configPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        LUMI_EXEC_PATH: process.execPath,
        LUMI_APP_PATH: app.isPackaged ? app.getAppPath() : resolve(getElectronMainDirname(), '..', '..', '..'),
        LUMI_USER_DATA_PATH: app.getPath('userData'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    child.stdout.on('data', data => appendLog(String(data)))
    child.stderr.on('data', data => appendLog(`[error] ${String(data)}`))
    child.once('exit', (code) => {
      child = undefined
      if (processState !== 'stopping' && code !== 0) {
        processState = 'error'
        lastError = `Lumi Server exited with code ${code ?? 'unknown'}`
      }
      else {
        processState = 'stopped'
      }
      window.webContents.send('lumi-server-manager:changed')
    })
    try {
      await waitForManagerHealth()
      processState = 'running'
      appendLog('Lumi Server Manager health check passed.')
    }
    catch (error) {
      processState = 'error'
      lastError = errorMessageFrom(error) ?? 'Lumi Server failed to start'
      throw error
    }
    return await state()
  }

  async function stop() {
    if (!child || child.exitCode !== null) {
      processState = 'stopped'
      return await state()
    }
    processState = 'stopping'
    const stoppingChild = child
    stoppingChild.stdin.write('shutdown\n')
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        stoppingChild.kill()
        resolveStop()
      }, 15_000)
      stoppingChild.once('exit', () => {
        clearTimeout(timer)
        resolveStop()
      })
    })
    processState = 'stopped'
    return await state()
  }

  async function managerRequest(path: string, init?: { method?: string, body?: unknown }) {
    const config = await loadLumiServerConfig(configPath)
    const response = await fetch(`http://127.0.0.1:${config.manager.port}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${config.manager.token}`,
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok)
      throw new Error(typeof payload?.error === 'string' ? payload.error : `Manager request failed (${response.status})`)
    return payload
  }

  async function waitForManagerHealth() {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        await managerRequest('/health')
        return
      }
      catch {
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    throw new Error('Lumi Server did not become healthy within 20 seconds')
  }

  ipcMain.handle('lumi-server-manager:state', async (event) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await state())
  })
  ipcMain.handle('lumi-server-manager:start', async (event) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await start())
  })
  ipcMain.handle('lumi-server-manager:stop', async (event) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await stop())
  })
  ipcMain.handle('lumi-server-manager:request', async (event, input: { path: string, method?: string, body?: unknown }) => {
    assertSender(event.sender.id)
    if (!/^\/(?:overview|users|devices|devices\/revoke|invitations|bootstrap\/doggy|tools\/status|tools\/resource-leases\/terminate|plugins\/status|memory\/vector\/(?:status|backfill)|data\/(?:migrations\/(?:stage|commit)|backups))$/.test(input.path))
      throw new Error('Manager API path is not allowed')
    return cloneIpcValue(await managerRequest(input.path, input))
  })
  ipcMain.handle('lumi-server-manager:migration:pick', async (event) => {
    assertSender(event.sender.id)
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Lumi migration', extensions: ['json'] }] })
    if (selection.canceled || !selection.filePaths[0])
      return undefined
    const migration = JSON.parse(await readFile(selection.filePaths[0], 'utf8'))
    return await managerRequest('/data/migrations/stage', { method: 'POST', body: migration })
  })
  ipcMain.handle('lumi-server-manager:backup:restore', async (event) => {
    assertSender(event.sender.id)
    if (processState !== 'stopped' && processState !== 'error')
      throw new Error('Stop Lumi Server before disaster recovery')
    const selection = await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Lumi backup manifest', extensions: ['json'] }] })
    const manifestPath = selection.filePaths[0]
    if (selection.canceled || !manifestPath)
      return undefined
    const confirmation = await dialog.showMessageBox(window, {
      type: 'warning',
      buttons: ['取消', '恢复服务器'],
      defaultId: 0,
      cancelId: 0,
      title: '恢复 Lumi Server',
      message: '这会用所选完整备份替换服务器数据。恢复前将自动创建当前数据的安全备份。',
    })
    if (confirmation.response !== 1)
      return undefined
    const config = await loadLumiServerConfig(configPath)
    const database = LumiServerDatabase.open(join(config.dataDirectory, 'lumi-server.sqlite3'))
    try {
      const safetyBackup = await writeLumiServerBackup(database, join(config.dataDirectory, 'backups', 'pre-restore'))
      const restored = await restoreLumiServerBackup(database, manifestPath)
      appendLog(`Disaster recovery completed from ${manifestPath}; safety backup: ${safetyBackup.manifestPath}`)
      return { restored, safetyBackup }
    }
    finally {
      database.close()
    }
  })
  ipcMain.handle('lumi-server-manager:autostart', async (event, enabled: boolean) => {
    assertSender(event.sender.id)
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--lumi-server-manager', '--start-server'] })
    return await state()
  })
  ipcMain.handle('lumi-server-manager:provider:models', async (event, input: Record<string, unknown>) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await listProviderModels(await providerInput(configPath, input)))
  })
  ipcMain.handle('lumi-server-manager:provider:test', async (event, input: Record<string, unknown>) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await testProviderConnection(await providerInput(configPath, input)))
  })
  ipcMain.handle('lumi-server-manager:provider:balance', async (event, input: Record<string, unknown>) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await getDeepSeekBalance(await providerInput(configPath, input)))
  })
  ipcMain.handle('lumi-server-manager:transcription:test', async (event, input: Record<string, unknown>) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await testProviderAccess(await transcriptionProviderInput(configPath, input)))
  })
  ipcMain.handle('lumi-server-manager:mcp:test', async (event, input: { name: string, config: Record<string, unknown> }) => {
    assertSender(event.sender.id)
    if (processState !== 'stopped' && processState !== 'error')
      throw new Error('测试未保存的 MCP 配置前请先停止 Lumi Server')
    const registry = new LumiServerMcpRegistry('0.10.2')
    try {
      await registry.apply({
        mcpServers: {
          [input.name]: { ...input.config, enabled: true, startupMode: 'on_startup' },
        },
      })
      return cloneIpcValue(registry.statusesSnapshot()[0])
    }
    finally {
      await registry.stopAll()
    }
  })
  ipcMain.handle('lumi-server-manager:plugins:list', async (event) => {
    assertSender(event.sender.id)
    const config = await loadLumiServerConfig(configPath)
    return cloneIpcValue(await listServerPlugins(config.plugins.directory, new Set(config.plugins.enabled)))
  })
  ipcMain.handle('lumi-server-manager:plugins:open', async (event) => {
    assertSender(event.sender.id)
    const config = await loadLumiServerConfig(configPath)
    if (!config.plugins.directory)
      throw new Error('Server 插件目录尚未配置')
    await shell.openPath(config.plugins.directory)
    return { path: config.plugins.directory }
  })
  ipcMain.handle('lumi-server-manager:plugins:add', async (event) => {
    assertSender(event.sender.id)
    const selection = await dialog.showOpenDialog(window, { properties: ['openDirectory'], title: '选择包含 plugin.airi.json 的插件目录' })
    const source = selection.filePaths[0]
    if (selection.canceled || !source)
      return undefined
    const manifestPath = join(source, 'plugin.airi.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown }
    if (typeof manifest.name !== 'string' || !manifest.name.trim())
      throw new Error('所选目录没有有效的 plugin.airi.json')
    const config = await loadLumiServerConfig(configPath)
    if (!config.plugins.directory)
      throw new Error('Server 插件目录尚未配置')
    await mkdir(config.plugins.directory, { recursive: true })
    const folderName = basename(source).replace(/[^w.-]/gi, '-')
    const destination = join(config.plugins.directory, folderName)
    if (existsSync(destination))
      throw new Error(`插件目录已存在：${folderName}`)
    await cp(source, destination, { recursive: true, errorOnExist: true })
    return cloneIpcValue(await listServerPlugins(config.plugins.directory, new Set(config.plugins.enabled)))
  })
  ipcMain.handle('lumi-server-manager:config:update', async (event, patch: Record<string, unknown>) => {
    assertSender(event.sender.id)
    return cloneIpcValue(await applyConfigPatch(cloneIpcRecord(patch)))
  })
  ipcMain.handle('lumi-server-manager:astrbot-token:copy', async (event) => {
    assertSender(event.sender.id)
    const config = await loadLumiServerConfig(configPath)
    if (!config.astrbot?.apiToken)
      throw new Error('AstrBot integration token is unavailable')
    clipboard.writeText(config.astrbot.apiToken)
  })

  async function applyConfigPatch(patch: Record<string, unknown>) {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
    const next = {
      ...raw,
      publicBaseURL: typeof patch.publicBaseURL === 'string' ? patch.publicBaseURL : raw.publicBaseURL,
      hostname: typeof patch.hostname === 'string' ? patch.hostname : raw.hostname,
      port: typeof patch.port === 'number' ? patch.port : raw.port,
      model: {
        ...raw.model,
        ...(typeof patch.modelProviderId === 'string' ? { providerId: patch.modelProviderId } : {}),
        ...(typeof patch.modelBaseURL === 'string' ? { baseURL: patch.modelBaseURL } : {}),
        ...(typeof patch.modelName === 'string' ? { model: patch.modelName } : {}),
        ...(typeof patch.modelApiKey === 'string' && patch.modelApiKey ? { apiKey: patch.modelApiKey } : {}),
        ...(typeof patch.modelTemperature === 'number' ? { temperature: patch.modelTemperature } : {}),
        ...(typeof patch.modelMaxOutputTokens === 'number' ? { maxOutputTokens: patch.modelMaxOutputTokens } : {}),
        ...(typeof patch.modelMaxContextTokens === 'number' ? { maxContextTokens: patch.modelMaxContextTokens } : {}),
        ...(typeof patch.modelOutputReserveTokens === 'number' ? { outputReserveTokens: patch.modelOutputReserveTokens } : {}),
        ...(typeof patch.modelPromptReserveTokens === 'number' ? { promptReserveTokens: patch.modelPromptReserveTokens } : {}),
        ...(typeof patch.modelMaxSteps === 'number' ? { maxSteps: patch.modelMaxSteps } : {}),
        ...(typeof patch.modelThinkingMode === 'string' ? { thinkingMode: patch.modelThinkingMode } : {}),
        ...(typeof patch.modelReasoningEffort === 'string' ? { reasoningEffort: patch.modelReasoningEffort } : {}),
        ...(patch.modelProviderOptions && typeof patch.modelProviderOptions === 'object' && !Array.isArray(patch.modelProviderOptions) ? { providerOptions: patch.modelProviderOptions } : {}),
      },
      agentRuntime: {
        ...raw.agentRuntime,
        ...(typeof patch.agentPromptDirectory === 'string' ? { promptDirectory: patch.agentPromptDirectory } : {}),
        ...(typeof patch.agentRuntimeMode === 'string' ? { mode: patch.agentRuntimeMode } : {}),
        ...(typeof patch.agentPlannerMaxRounds === 'number' ? { plannerMaxRounds: patch.agentPlannerMaxRounds } : {}),
        ...(typeof patch.agentPlannerFinalizationMode === 'string' ? { plannerFinalizationMode: patch.agentPlannerFinalizationMode } : {}),
        ...(typeof patch.agentMergeWindowMs === 'number' ? { mergeWindowMs: patch.agentMergeWindowMs } : {}),
        ...(typeof patch.agentToolMaxConcurrency === 'number' ? { toolMaxConcurrency: patch.agentToolMaxConcurrency } : {}),
        ...(typeof patch.agentToolStepTimeoutMs === 'number' ? { toolStepTimeoutMs: patch.agentToolStepTimeoutMs } : {}),
        ...(typeof patch.agentDeferredToolsEnabled === 'boolean' ? { deferredToolsEnabled: patch.agentDeferredToolsEnabled } : {}),
        ...(typeof patch.agentExpressionSelectorEnabled === 'boolean' ? { expressionSelectorEnabled: patch.agentExpressionSelectorEnabled } : {}),
        ...(typeof patch.agentDirectLanguageFeedbackEnabled === 'boolean' ? { directLanguageFeedbackEnabled: patch.agentDirectLanguageFeedbackEnabled } : {}),
        ...(typeof patch.agentPromptLoggingEnabled === 'boolean' ? { promptLoggingEnabled: patch.agentPromptLoggingEnabled } : {}),
        ...(typeof patch.agentPlannerHistoryBudgetTokens === 'number' ? { plannerHistoryBudgetTokens: patch.agentPlannerHistoryBudgetTokens } : {}),
        ...(typeof patch.agentContextCompactionThresholdTokens === 'number' ? { contextCompactionThresholdTokens: patch.agentContextCompactionThresholdTokens } : {}),
        ...(typeof patch.agentContextRecentTokens === 'number' ? { contextRecentTokens: patch.agentContextRecentTokens } : {}),
      },
      languageLearning: {
        ...raw.languageLearning,
        ...(typeof patch.directLanguageCandidateLearningEnabled === 'boolean'
          ? { directLanguageCandidateLearningEnabled: patch.directLanguageCandidateLearningEnabled }
          : {}),
        ...(typeof patch.groupExpressionLearningEnabled === 'boolean'
          ? { groupExpressionLearningEnabled: patch.groupExpressionLearningEnabled }
          : {}),
        ...(typeof patch.groupJargonLearningEnabled === 'boolean'
          ? { groupJargonLearningEnabled: patch.groupJargonLearningEnabled }
          : {}),
        ...(typeof patch.groupBehaviorLearningEnabled === 'boolean'
          ? { groupBehaviorLearningEnabled: patch.groupBehaviorLearningEnabled }
          : {}),
        ...(typeof patch.groupPublicKnowledgeLearningEnabled === 'boolean'
          ? { groupPublicKnowledgeLearningEnabled: patch.groupPublicKnowledgeLearningEnabled }
          : {}),
      },
      vector: {
        ...raw.vector,
        ...(typeof patch.vectorEnabled === 'boolean' ? { enabled: patch.vectorEnabled } : {}),
        ...(typeof patch.vectorModel === 'string' ? { model: patch.vectorModel } : {}),
        ...(typeof patch.vectorDevice === 'string' ? { device: patch.vectorDevice } : {}),
        ...(typeof patch.vectorPythonPath === 'string' ? { pythonPath: patch.vectorPythonPath || undefined } : {}),
      },
      transcription: {
        ...(raw.transcription ?? { baseURL: 'https://api.openai.com/v1/', model: 'whisper-1' }),
        ...(typeof patch.transcriptionEnabled === 'boolean' ? { enabled: patch.transcriptionEnabled } : {}),
        ...(typeof patch.transcriptionProviderId === 'string' ? { providerId: patch.transcriptionProviderId } : {}),
        ...(typeof patch.transcriptionBaseURL === 'string' ? { baseURL: patch.transcriptionBaseURL } : {}),
        ...(typeof patch.transcriptionModel === 'string' ? { model: patch.transcriptionModel } : {}),
        ...(typeof patch.transcriptionLanguage === 'string' ? { language: patch.transcriptionLanguage || undefined } : {}),
        ...(typeof patch.transcriptionPrompt === 'string' ? { prompt: patch.transcriptionPrompt || undefined } : {}),
        ...(typeof patch.transcriptionMaxVoiceBytes === 'number' ? { maxVoiceBytes: patch.transcriptionMaxVoiceBytes } : {}),
        ...(typeof patch.transcriptionApiKey === 'string' && patch.transcriptionApiKey ? { apiKey: patch.transcriptionApiKey } : {}),
      },
      trustedOrigins: Array.isArray(patch.trustedOrigins) ? patch.trustedOrigins.filter(value => typeof value === 'string') : raw.trustedOrigins,
      mcp: patch.mcp && typeof patch.mcp === 'object' && !Array.isArray(patch.mcp) ? patch.mcp : raw.mcp,
      plugins: patch.plugins && typeof patch.plugins === 'object' && !Array.isArray(patch.plugins) ? patch.plugins : raw.plugins,
      background: {
        ...raw.background,
        ...(patch.background && typeof patch.background === 'object' && !Array.isArray(patch.background) ? patch.background : {}),
      },
      astrbot: {
        ...raw.astrbot,
        ...(typeof patch.astrbotEnabled === 'boolean' ? { enabled: patch.astrbotEnabled } : {}),
        ...(Array.isArray(patch.astrbotIdentityBindings)
          ? {
              identityBindings: patch.astrbotIdentityBindings.filter(binding =>
                binding
                && typeof binding === 'object'
                && !Array.isArray(binding)
                && typeof binding.platformInstanceId === 'string'
                && typeof binding.externalUserId === 'string'
                && typeof binding.personId === 'string',
              ),
            }
          : {}),
        ...(typeof patch.astrbotPrivateReplyEnabled === 'boolean'
          ? { privateReplyEnabled: patch.astrbotPrivateReplyEnabled }
          : {}),
        ...(typeof patch.astrbotGroupObservationEnabled === 'boolean'
          ? { groupObservationEnabled: patch.astrbotGroupObservationEnabled }
          : {}),
        ...(Array.isArray(patch.astrbotStudyGroups) ? { studyGroups: patch.astrbotStudyGroups } : {}),
        ...(typeof patch.astrbotObservationBatchSize === 'number'
          ? { observationBatchSize: patch.astrbotObservationBatchSize }
          : {}),
        ...(patch.astrbotStickerLibrary && typeof patch.astrbotStickerLibrary === 'object' && !Array.isArray(patch.astrbotStickerLibrary)
          ? { stickerLibrary: patch.astrbotStickerLibrary }
          : {}),
      },
      tls: patch.tlsEnabled === false
        ? undefined
        : patch.tls && typeof patch.tls === 'object' && !Array.isArray(patch.tls) ? patch.tls : raw.tls,
    }
    const temporary = `${configPath}.tmp`
    const previous = `${configPath}.previous`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await loadLumiServerConfig(temporary)
    const shouldRestart = processState === 'running' || processState === 'starting'
    if (shouldRestart)
      await stop()
    await rm(previous, { force: true })
    await rename(configPath, previous)
    await rename(temporary, configPath)
    try {
      if (shouldRestart)
        await start()
      await rm(previous, { force: true })
      return await state()
    }
    catch (error) {
      await rm(configPath, { force: true })
      await rename(previous, configPath)
      if (shouldRestart)
        await start().catch(rollbackError => appendLog(`[error] rollback start failed: ${String(rollbackError)}`))
      throw error
    }
  }

  window.on('close', (event) => {
    if (!child)
      return
    event.preventDefault()
    void stop().then(() => window.destroy())
  })
  await load(window, baseUrl(join(getElectronMainDirname(), '..', 'renderer'), 'server-manager.html'))
  if (process.argv.includes('--start-server'))
    void start().catch(error => appendLog(`[error] ${String(error)}`))
  return { window, start, stop }
}

async function providerInput(configPath: string, input: Record<string, unknown>) {
  const config = await loadLumiServerConfig(configPath)
  return {
    providerId: typeof input.providerId === 'string' ? input.providerId : config.model.providerId,
    baseURL: typeof input.baseURL === 'string' ? input.baseURL : config.model.baseURL,
    apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey : config.model.apiKey,
    model: typeof input.model === 'string' ? input.model : config.model.model,
    modelList: input.modelList === 'static' ? 'static' as const : 'api' as const,
    defaultModels: Array.isArray(input.defaultModels) ? input.defaultModels.filter((value): value is string => typeof value === 'string') : [],
  }
}

async function transcriptionProviderInput(configPath: string, input: Record<string, unknown>) {
  const config = await loadLumiServerConfig(configPath)
  return {
    providerId: typeof input.providerId === 'string' ? input.providerId : config.transcription?.providerId,
    baseURL: typeof input.baseURL === 'string' ? input.baseURL : config.transcription?.baseURL ?? '',
    apiKey: typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey : config.transcription?.apiKey,
  }
}

async function importLegacyMcpConfig(configPath: string) {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
  if (raw._managerMigrations?.legacyMcpImported === true)
    return

  const candidates = [
    join(app.getPath('appData'), '@proj-airi', 'stage-tamagotchi', 'mcp.json'),
    join(app.getPath('appData'), 'lumi', 'mcp.json'),
  ]
  const imported: Record<string, unknown> = {}
  for (const path of candidates) {
    if (!existsSync(path))
      continue
    try {
      const legacy = JSON.parse(await readFile(path, 'utf8')) as { mcpServers?: Record<string, unknown> }
      for (const [name, config] of Object.entries(legacy.mcpServers ?? {})) {
        if (!(name in imported) && config && typeof config === 'object' && !Array.isArray(config))
          imported[name] = config
      }
    }
    catch {
      // A malformed legacy file must never prevent Server Manager startup.
    }
  }

  const current = raw.mcp?.mcpServers && typeof raw.mcp.mcpServers === 'object'
    ? raw.mcp.mcpServers as Record<string, unknown>
    : {}
  raw.mcp = { ...raw.mcp, mcpServers: { ...imported, ...current } }
  raw._managerMigrations = { ...raw._managerMigrations, legacyMcpImported: true }
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

async function normalizeLegacyMcpRuntimePaths(configPath: string) {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
  if (raw._managerMigrations?.runtimeMcpPathsNormalized === true)
    return
  const servers = raw.mcp?.mcpServers && typeof raw.mcp.mcpServers === 'object'
    ? raw.mcp.mcpServers as Record<string, Record<string, unknown>>
    : {}
  const absoluteDirectories = Object.values(servers)
    .map(server => typeof server.cwd === 'string' && isAbsolute(server.cwd) ? server.cwd : '')
    .filter(Boolean)

  for (const server of Object.values(servers)) {
    if (typeof server.command === 'string' && ['node', 'node.exe'].includes(server.command.trim().toLowerCase())) {
      server.command = '$' + '{LUMI_EXEC_PATH}'
      server.env = {
        ...(server.env && typeof server.env === 'object' && !Array.isArray(server.env) ? server.env : {}),
        ELECTRON_RUN_AS_NODE: '1',
      }
    }
    if (typeof server.cwd !== 'string' || !server.cwd.trim() || isAbsolute(server.cwd) || server.cwd === '.')
      continue
    const resolved = findExistingLegacyDirectory(server.cwd, absoluteDirectories)
    if (resolved)
      server.cwd = resolved
  }

  raw._managerMigrations = { ...raw._managerMigrations, runtimeMcpPathsNormalized: true }
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function findExistingLegacyDirectory(relativeDirectory: string, seeds: string[]) {
  for (const seed of seeds) {
    let candidate = resolve(seed)
    for (let depth = 0; depth < 8; depth += 1) {
      const target = resolve(candidate, relativeDirectory)
      if (existsSync(target))
        return target
      const parent = dirname(candidate)
      if (parent === candidate)
        break
      candidate = parent
    }
  }
  return undefined
}

async function ensureServerPluginDefaults(configPath: string) {
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, any>
  if (raw.plugins?.directory)
    return
  const pluginsRoot = resolveDefaultPluginsRoot()
  raw.plugins = {
    ...raw.plugins,
    directory: pluginsRoot,
    enabled: Array.isArray(raw.plugins?.enabled) ? raw.plugins.enabled : ['lumi-diary'],
    settings: raw.plugins?.settings && typeof raw.plugins.settings === 'object' ? raw.plugins.settings : {},
  }
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
}

function resolveDefaultPluginsRoot() {
  if (app.isPackaged)
    return join(dirname(app.getPath('exe')), 'plugins', 'v1')

  let current = resolve(process.cwd())
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'external-plugins')
    if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(candidate))
      return candidate
    const parent = dirname(current)
    if (parent === current)
      break
    current = parent
  }
  return join(process.cwd(), 'external-plugins')
}

async function listServerPlugins(directory: string | undefined, enabled: Set<string>) {
  if (!directory)
    return { directory: '', plugins: [] }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const plugins = []
  for (const entry of entries) {
    if (!entry.isDirectory())
      continue
    const path = join(directory, entry.name, 'plugin.airi.json')
    try {
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>
      if (typeof manifest.name !== 'string')
        continue
      plugins.push({
        name: manifest.name,
        path,
        enabled: enabled.has(manifest.name),
        serverCompatible: typeof manifest.entrypoints?.server === 'string' || typeof manifest.entrypoints?.default === 'string',
        permissions: Array.isArray(manifest.permissions?.resources)
          ? manifest.permissions.resources.map((item: Record<string, unknown>) => item.key).filter((key: unknown): key is string => typeof key === 'string')
          : [],
      })
    }
    catch {
      plugins.push({ name: entry.name, path, enabled: false, serverCompatible: false, permissions: [], error: '插件清单无法读取' })
    }
  }
  return { directory, plugins }
}
