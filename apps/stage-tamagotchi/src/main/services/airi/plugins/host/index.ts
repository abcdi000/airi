import type {
  PluginHostDebugSnapshot,
  PluginRegistrySnapshot,
} from '../../../../../shared/eventa/plugin/host'
import type {
  PluginAssetCookie,
  PluginAssetSession,
  PluginAssetSnapshotService,
} from '../features/static-assets'
import type {
  PluginHostService,
  SetupPluginHostOptions,
} from '../types'

import { cp, lstat, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { dirname, join, normalize, relative } from 'node:path'
import process from 'node:process'

import { useLogg } from '@guiiai/logg'
import { PluginHost } from '@proj-airi/plugin-sdk/plugin-host'
import { app, dialog, session as electronSession, shell } from 'electron'

import { createPluginAutoReloadFeature } from '../features/auto-reload'
import { createPluginAssetService } from '../features/static-assets'
import { createBuiltInPluginKitRuntime } from '../kits'
import { createPluginHostConfigStore } from './config'
import { buildPluginHostDebugSnapshot } from './debug'
import {
  buildPluginRegistrySnapshot,
  createManifestForLoad,
  createPluginHostRegistry,
  pluginManifestFileName,
  resolvePluginRuntimeEntrypointPath,
} from './registry'

const extensionAssetSessionTtlMs = 30 * 24 * 60 * 60 * 1000

function createElectronPluginAssetCookieAdapter() {
  return {
    async setCookie(cookie: PluginAssetCookie) {
      await electronSession.defaultSession.cookies.set({
        url: cookie.url,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        httpOnly: true,
        sameSite: 'no_restriction',
        secure: true,
        expirationDate: Math.floor(cookie.expiresAt / 1000),
      })
    },
    async removeCookie(cookie: PluginAssetCookie) {
      await electronSession.defaultSession.cookies.remove(cookie.url, cookie.name)
    },
  }
}

function isPathInside(parent: string, child: string) {
  const delta = relative(parent, child)
  return delta === '' || (!!delta && !delta.startsWith('..') && !normalize(delta).startsWith('..'))
}

function sanitizePluginDirectoryName(name: string) {
  return name
    .replace(/^@/, '')
    .replace(/[\\/:"*?<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'plugin'
}

function resolveDefaultPluginsRoot() {
  const override = process.env.AIRI_PLUGIN_ROOT?.trim()
  if (override)
    return override

  if (!app.isPackaged)
    return join(process.cwd(), 'external-plugins')

  return join(dirname(app.getPath('exe')), 'plugins', 'v1')
}

async function migrateLegacyPluginsRoot(options: {
  legacyRoot: string
  pluginsRoot: string
  log: ReturnType<typeof useLogg>
}) {
  const legacyRoot = normalize(options.legacyRoot)
  const pluginsRoot = normalize(options.pluginsRoot)
  if (legacyRoot === pluginsRoot)
    return

  let entries
  try {
    entries = await readdir(legacyRoot, { withFileTypes: true })
  }
  catch {
    return
  }

  await mkdir(pluginsRoot, { recursive: true })
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink())
      continue

    const source = join(legacyRoot, entry.name)
    const target = join(pluginsRoot, entry.name)
    try {
      await lstat(target)
      continue
    }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code !== 'ENOENT')
        throw error
    }

    try {
      await cp(source, target, { recursive: true, force: false, errorOnExist: true })
      options.log.withFields({ source, target }).log('legacy plugin copied to install plugin root')
    }
    catch (error) {
      options.log.withError(error).withFields({ source, target }).warn('failed to copy legacy plugin into install plugin root')
    }
  }
}

/**
 * Internal plugin host bootstrap service used by the public `setupPluginHost(...)` facade.
 *
 * Use when:
 * - `plugins/index.ts` needs a smaller orchestration layer with the same caller-facing API
 * - Host wiring should stay separate from config, registry, and snapshot helpers
 *
 * Expects:
 * - Consumers treat this as an internal bootstrap surface and keep the public facade unchanged
 * - `widgetsManager` is ready before startup begins
 *
 * Returns:
 * - The plain `PluginHostService` fields plus internal helpers for list/load/unload/inspect/dispose
 */
export interface PluginHostHostService extends PluginHostService {
  /**
   * Lists the current plugin registry snapshot.
   *
   * Use when:
   * - IPC callers need the latest discovered plugin entries and enablement state
   * - Host operations need a refreshed renderer-facing registry view
   *
   * Expects:
   * - Manifest discovery can be refreshed before the snapshot is built
   *
   * Returns:
   * - The latest plugin registry snapshot for renderer consumption
   */
  list: () => Promise<PluginRegistrySnapshot>

  /**
   * Persists whether one plugin is enabled.
   *
   * Use when:
   * - Renderer controls toggle plugin enablement
   * - Host state must remember a known manifest path for a plugin name
   *
   * Expects:
   * - `payload.name` matches a discovered or previously known plugin
   * - `payload.path` is only needed when the manifest is not currently discoverable
   *
   * Returns:
   * - The updated plugin registry snapshot after persistence
   */
  setEnabled: (payload: { name: string, enabled: boolean, path?: string }) => Promise<PluginRegistrySnapshot>

  /**
   * Persists whether one loaded plugin should use auto-reload.
   *
   * Use when:
   * - Renderer controls toggle plugin file watching during development
   * - Host features need to resync optional watcher state after config changes
   *
   * Expects:
   * - `payload.name` matches one plugin entry in config or discovery state
   *
   * Returns:
   * - The updated plugin registry snapshot after persistence
   */
  setAutoReload: (payload: { name: string, enabled: boolean }) => Promise<PluginRegistrySnapshot>

  /**
   * Opens the plugin manifest root in the host operating system file manager.
   */
  openRoot: () => Promise<{ path: string }>

  /**
   * Lets the user choose a local plugin directory and links it into the
   * plugin manifest root for discovery.
   */
  addFromDirectory: () => Promise<PluginRegistrySnapshot>

  /**
   * Removes one discovered plugin from the plugin root and unloads it first
   * when needed.
   */
  remove: (payload: { name: string }) => Promise<PluginRegistrySnapshot>

  /**
   * Loads every plugin currently marked as enabled.
   *
   * Use when:
   * - App startup wants to restore persisted enabled plugins
   * - Renderer requests a bulk load after configuration changes
   *
   * Expects:
   * - Discovery state is current before load begins
   *
   * Returns:
   * - The plugin registry snapshot after load attempts finish
   */
  loadEnabled: () => Promise<PluginRegistrySnapshot>

  /**
   * Loads one plugin by manifest name.
   *
   * Use when:
   * - Renderer explicitly requests one plugin to start
   * - Host features need to restart a plugin after manifest or entrypoint changes
   *
   * Expects:
   * - `name` resolves to a manifest entry in the current registry
   *
   * Returns:
   * - The plugin registry snapshot after the load completes
   */
  load: (name: string) => Promise<PluginRegistrySnapshot>

  /**
   * Stops one loaded plugin by manifest name.
   *
   * Use when:
   * - Renderer explicitly requests one plugin to stop
   * - Host features need to stop a plugin before reload or disposal
   *
   * Expects:
   * - `name` identifies a plugin that may or may not currently be loaded
   *
   * Returns:
   * - The plugin registry snapshot after unload bookkeeping completes
   */
  unload: (name: string) => Promise<PluginRegistrySnapshot>

  /**
   * Builds the full plugin host debug snapshot.
   *
   * Use when:
   * - Devtools need sessions, kits, bindings, capabilities, and rewritten asset URLs
   * - Host debugging needs a fresh runtime snapshot after registry refresh
   *
   * Expects:
   * - The host and plugin asset service are both initialized
   *
   * Returns:
   * - The full debug snapshot exposed through plugin inspection IPC
   */
  inspect: () => Promise<PluginHostDebugSnapshot>

  /**
   * Returns the mounted base URL for plugin-served assets.
   *
   * Use when:
   * - Renderer code needs to construct extension asset URLs
   * - Snapshot consumers need the current loopback asset mount base
   *
   * Expects:
   * - The plugin asset service may be started before this is called
   *
   * Returns:
   * - The current plugin asset base URL, or an empty string when unavailable
   */
  getAssetBaseUrl: () => string

  /**
   * Disposes optional host features and asset hosting resources.
   *
   * Use when:
   * - Electron shutdown needs to stop plugin-owned background work
   * - Tests need to release watchers and local asset servers deterministically
   *
   * Expects:
   * - Disposal may be called after partial startup or after prior plugin failures
   *
   * Returns:
   * - A promise that resolves after feature and asset cleanup finish
   */
  dispose: () => Promise<void>
}

/**
 * Builds the extracted Electron plugin host bootstrap used by the public facade.
 *
 * Use when:
 * - The public plugin service wants one internal bootstrap entrypoint
 * - Tests need direct access to the internal host bootstrap helper
 *
 * Expects:
 * - Electron app paths are available
 * - Plugin manifests live under the install/project plugin root
 *
 * Returns:
 * - The internal bootstrap service that powers the public plugin-host IPC facade
 */
export async function setupPluginHostHostService(
  options: SetupPluginHostOptions,
): Promise<PluginHostHostService> {
  const log = useLogg('main/plugin-host').useGlobalConfig()
  const pluginsRoot = resolveDefaultPluginsRoot()
  const legacyPluginsRoot = join(app.getPath('userData'), 'plugins', 'v1')
  await migrateLegacyPluginsRoot({ legacyRoot: legacyPluginsRoot, pluginsRoot, log })

  // Config
  const pluginConfig = createPluginHostConfigStore()
  pluginConfig.setup()

  // Kit API, Host
  const builtInKitRuntime = createBuiltInPluginKitRuntime(options)
  const host = new PluginHost({ runtime: 'electron', contributions: builtInKitRuntime.contributions })
  builtInKitRuntime.attachHost(host) // reverse dependency injection
  log.withFields({ pluginsRoot }).log('loading plugin manifests')
  // Once kit injected the host, then apply kits
  builtInKitRuntime.registerHostKits(host)

  // plugin registry
  const pluginRegistry = createPluginHostRegistry({ pluginsRoot, log })

  await pluginRegistry.refresh()
  log.withFields({ count: pluginRegistry.listEntries().length }).log('plugin manifests loaded')
  for (const entry of pluginRegistry.listEntries()) {
    log.withFields({ name: entry.manifest.name, path: entry.path }).log('plugin manifest found')
  }

  // Plugin feature: Static Assets serving
  const pluginAssetService = createPluginAssetService({
    getManifestEntryByName: () => pluginRegistry.getManifestEntryByName(),
    cookieAdapter: createElectronPluginAssetCookieAdapter(),
  })
  await pluginAssetService.start()

  const loaded = new Set<string>()
  const loadedSessionIds = new Map<string, string>()
  const moduleAssetSessionCache = new Map<string, PluginAssetSession>()

  const clearModuleAssetSessionCacheByPluginId = (pluginId: string) => {
    for (const key of moduleAssetSessionCache.keys()) {
      if (key.startsWith(`${pluginId}:`)) {
        moduleAssetSessionCache.delete(key)
      }
    }
  }

  const clearModuleAssetSessionCacheByOwnerSessionId = (ownerSessionId: string) => {
    for (const key of moduleAssetSessionCache.keys()) {
      const segments = key.split(':')
      if (segments[2] === ownerSessionId) {
        moduleAssetSessionCache.delete(key)
      }
    }
  }

  const refreshManifests = async () => {
    await pluginRegistry.refresh()
  }

  const getConfig = () => pluginConfig.get()

  const listSnapshot = (): PluginRegistrySnapshot => {
    return buildPluginRegistrySnapshot({
      pluginsRoot,
      entries: pluginRegistry.listEntries(),
      config: getConfig(),
      loaded,
    })
  }

  const createModuleAssetSession = async (input: {
    pluginId: string
    version: string
    ownerSessionId: string
    routeAssetPath: string
    pathPrefix: string
  }) => {
    const { pluginId, version, ownerSessionId, routeAssetPath, pathPrefix } = input
    const cacheKey = `${pluginId}:${version}:${ownerSessionId}:${routeAssetPath}:${pathPrefix}`
    const cachedSession = moduleAssetSessionCache.get(cacheKey)
    if (cachedSession) {
      return cachedSession
    }

    const session = await pluginAssetService.createAssetSession({
      pluginId,
      version,
      ownerSessionId,
      routeAssetPath,
      pathPrefix,
      ttlMs: extensionAssetSessionTtlMs,
    })
    moduleAssetSessionCache.set(cacheKey, session)
    return session
  }

  const pluginAssetSnapshotService: PluginAssetSnapshotService = {
    getBaseUrl: pluginAssetService.getBaseUrl,
    createAssetSession: ({ pluginId, version, ownerSessionId, routeAssetPath, pathPrefix }) => {
      return createModuleAssetSession({
        pluginId,
        version,
        ownerSessionId,
        routeAssetPath,
        pathPrefix,
      })
    },
  }

  const inspectSnapshot = async (): Promise<PluginHostDebugSnapshot> => {
    return await buildPluginHostDebugSnapshot({
      host,
      pluginsRoot,
      entries: pluginRegistry.listEntries(),
      config: getConfig(),
      loaded,
      manifestEntryByName: pluginRegistry.getManifestEntryByName(),
      pluginAssetService: pluginAssetSnapshotService,
    })
  }

  const loadPluginByName = async (
    name: string,
    loadOptions: { cacheBustKey?: string } = {},
  ) => {
    if (loaded.has(name)) {
      return
    }

    const entry = pluginRegistry.findManifestEntry(name)
    if (!entry) {
      throw new Error(`Plugin manifest not found: ${name}`)
    }

    const manifestForLoad = createManifestForLoad(entry, loadOptions)
    const session = await host.start(manifestForLoad, { cwd: dirname(entry.path) })
    loaded.add(name)
    loadedSessionIds.set(name, session.id)
    log.log('plugin loaded', { plugin: name, sessionId: session.id })
  }

  const stopLoadedPluginByName = async (name: string) => {
    const sessionId = loadedSessionIds.get(name)
    if (!sessionId) {
      loaded.delete(name)
      return
    }

    host.stop(sessionId)
    loadedSessionIds.delete(name)
    loaded.delete(name)

    clearModuleAssetSessionCacheByOwnerSessionId(sessionId)
    await pluginAssetService.revokeByOwnerSessionId(sessionId)

    log.log('plugin unloaded', { plugin: name, sessionId })
  }

  const resolveAutoReloadWatchPaths = (name: string) => {
    const entry = pluginRegistry.findManifestEntry(name)
    if (!entry) {
      return []
    }

    const entrypointPath = resolvePluginRuntimeEntrypointPath(entry)
    return [...new Set([entry.path, entrypointPath].filter((path): path is string => Boolean(path)))]
  }

  // Plugin feature: Auto-reload for plugins
  const autoReloadFeature = createPluginAutoReloadFeature({
    log,
    getConfig,
    listEntries: () => pluginRegistry.listEntries(),
    isLoaded: name => loaded.has(name),
    resolveWatchPaths: resolveAutoReloadWatchPaths,
    reload: async (name) => {
      await stopLoadedPluginByName(name)
      await refreshManifests()
      await loadPluginByName(name, { cacheBustKey: `auto-reload-${Date.now()}` })
    },
  })

  const unloadPluginByName = async (name: string) => {
    autoReloadFeature.clearPlugin(name)
    await stopLoadedPluginByName(name)
  }

  const addPluginFromDirectory = async () => {
    const result = await dialog.showOpenDialog({
      title: 'Select AIRI plugin directory',
      properties: ['openDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) {
      return listSnapshot()
    }

    const selectedDir = result.filePaths[0]
    const manifestPath = join(selectedDir, pluginManifestFileName)
    const raw = await readFile(manifestPath, 'utf-8').catch(() => {
      throw new Error(`Plugin manifest not found: ${manifestPath}`)
    })
    const manifest = JSON.parse(raw) as { name?: unknown }
    if (typeof manifest.name !== 'string' || !manifest.name.trim())
      throw new Error('Plugin manifest must include a non-empty `name`.')

    const linkName = sanitizePluginDirectoryName(manifest.name)
    const targetDir = join(pluginsRoot, linkName)
    try {
      await lstat(targetDir)
      throw new Error(`Plugin directory already exists: ${targetDir}`)
    }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
      if (code !== 'ENOENT')
        throw error
    }

    await symlink(selectedDir, targetDir, process.platform === 'win32' ? 'junction' : 'dir')
    await refreshManifests()
    return listSnapshot()
  }

  const removePluginByName = async (name: string) => {
    await refreshManifests()
    const entry = pluginRegistry.findManifestEntry(name)
    if (!entry)
      throw new Error(`Plugin manifest not found: ${name}`)

    await unloadPluginByName(name)
    clearModuleAssetSessionCacheByPluginId(name)
    await pluginAssetService.revokeByPluginId(name)

    const pluginDir = dirname(entry.path)
    if (!isPathInside(pluginsRoot, pluginDir))
      throw new Error(`Refusing to remove plugin outside plugin root: ${pluginDir}`)

    const stats = await lstat(pluginDir)
    if (stats.isSymbolicLink())
      await rm(pluginDir, { force: true })
    else
      await rm(pluginDir, { recursive: true, force: true })

    const config = getConfig()
    pluginConfig.update({
      enabled: config.enabled.filter(pluginName => pluginName !== name),
      autoReload: config.autoReload.filter(pluginName => pluginName !== name),
      known: Object.fromEntries(Object.entries(config.known).filter(([pluginName]) => pluginName !== name)),
    })

    await refreshManifests()
    autoReloadFeature.sync()
    return listSnapshot()
  }

  const loadEnabledPlugins = async () => {
    const config = getConfig()
    for (const entry of pluginRegistry.listEntries()) {
      const name = entry.manifest.name
      if (!config.enabled.includes(name)) {
        continue
      }
      if (loaded.has(name)) {
        continue
      }

      try {
        await loadPluginByName(name)
      }
      catch (error) {
        log.withError(error).withFields({ plugin: name }).error('plugin failed to start')
      }
    }

    autoReloadFeature.sync()
  }

  await refreshManifests()
  await loadEnabledPlugins()
  autoReloadFeature.sync()

  return {
    host,
    manifests: pluginRegistry.listManifests(),
    async list() {
      await refreshManifests()
      autoReloadFeature.sync()
      return listSnapshot()
    },
    async setEnabled(payload) {
      await refreshManifests()

      const config = getConfig()
      const enabled = new Set(config.enabled)
      if (payload.enabled) {
        enabled.add(payload.name)
      }
      else {
        enabled.delete(payload.name)
        clearModuleAssetSessionCacheByPluginId(payload.name)
        await pluginAssetService.revokeByPluginId(payload.name)
      }

      const entry = pluginRegistry.findManifestEntry(payload.name)
      const manifestPath = entry?.path ?? payload.path ?? ''
      pluginConfig.update({
        enabled: [...enabled],
        autoReload: config.autoReload,
        known: {
          ...config.known,
          [payload.name]: { path: manifestPath },
        },
      })

      autoReloadFeature.sync()
      return listSnapshot()
    },
    async setAutoReload(payload) {
      await refreshManifests()

      const config = getConfig()
      const autoReload = new Set(config.autoReload)
      if (payload.enabled) {
        autoReload.add(payload.name)
      }
      else {
        autoReload.delete(payload.name)
      }

      pluginConfig.update({
        ...config,
        autoReload: [...autoReload],
      })

      autoReloadFeature.sync()
      return listSnapshot()
    },
    async openRoot() {
      await refreshManifests()
      const openResult = await shell.openPath(pluginsRoot)
      if (openResult)
        throw new Error(openResult)
      return { path: pluginsRoot }
    },
    async addFromDirectory() {
      return await addPluginFromDirectory()
    },
    async remove(payload) {
      return await removePluginByName(payload.name)
    },
    async loadEnabled() {
      await refreshManifests()
      await loadEnabledPlugins()
      autoReloadFeature.sync()
      return listSnapshot()
    },
    async load(name) {
      await refreshManifests()
      await loadPluginByName(name)
      autoReloadFeature.sync()
      return listSnapshot()
    },
    async unload(name) {
      await unloadPluginByName(name)
      autoReloadFeature.sync()
      return listSnapshot()
    },
    async inspect() {
      await refreshManifests()
      autoReloadFeature.sync()
      return await inspectSnapshot()
    },
    getAssetBaseUrl() {
      return pluginAssetService.getBaseUrl() ?? ''
    },
    async dispose() {
      autoReloadFeature.dispose()

      moduleAssetSessionCache.clear()
      await pluginAssetService.revokeAll()
      await pluginAssetService.stop()
    },
  }
}
