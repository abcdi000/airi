import type {
  ElectronMcpStdioConfigFile,
  ElectronMcpStdioServerConfig,
} from '../../../../shared/eventa'

type TranslateMcpMessage = (key: string, params?: Record<string, unknown>) => string
type McpPresetId = 'minecraft' | 'computer_use' | 'playwright'

const LUMI_EXEC_PATH = '$' + '{LUMI_EXEC_PATH}'
const LUMI_APP_PATH = '$' + '{LUMI_APP_PATH}'
const LUMI_USER_DATA_PATH = '$' + '{LUMI_USER_DATA_PATH}'

/** Sensitive applications blocked by a newly created Computer Use preset. */
export const DEFAULT_COMPUTER_USE_DENY_APPS = [
  '1password',
  'bitwarden',
  'keepass',
  'keychain',
  'system settings',
  'windows security',
  'activity monitor',
  'lumi',
  'airi',
].join(',')

/** Editable MCP server form state used by the settings page. */
export interface ServerForm {
  rowId: string
  identifier: string
  command: string
  url: string
  headersEntries: { key: string, value: string }[]
  argsText: string
  envEntries: { key: string, value: string }[]
  cwd: string
  enabled: boolean
  startupMode: 'on_startup' | 'on_first_use' | 'manual'
  longRunning: boolean
  persistent: boolean
  requestTimeoutMs: string
  maxTotalTimeoutMs: string
}

/** Editable MCP server rows derived from persisted config. */
export interface LoadedServerForms {
  servers: ServerForm[]
  savedIds: Set<string>
  selectedRowId: string
  upgradedBrowserServers: string[]
}

/** One-click MCP preset shown by the desktop MCP settings page. */
export interface McpServerPreset {
  id: McpPresetId
  titleKey: string
  descriptionKey: string
  icon: string
  actionLabelKey: string
  addedMessageKey: string
  create: () => ServerForm
}

function makeRowId() {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function splitArgsText(argsText: string) {
  return argsText.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}

function envToObject(entries: { key: string, value: string }[]) {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) {
    const normalizedKey = key.trim()
    if (normalizedKey)
      out[normalizedKey] = value
  }
  return out
}

function isBundledLumiBrowserServer(server: ServerForm): boolean {
  return splitArgsText(server.argsText).some((arg) => {
    const normalized = arg.replaceAll('\\', '/')
    return normalized.includes('@proj-airi/playwright-extra-mcp')
      || normalized.includes('/services/playwright-extra-mcp/')
  })
}

function legacyBundledBrowserArgumentIndex(server: ServerForm): number {
  return splitArgsText(server.argsText).findIndex((arg) => {
    const normalized = arg.replaceAll('\\', '/')
    return normalized.includes('/services/playwright-extra-mcp/')
  })
}

/**
 * Adds dual-backend variables to a legacy bundled Lumi browser entry.
 *
 * Existing explicit values always win. The legacy Playwright profile path is
 * promoted to the shared profile variable so browser identity remains intact.
 */
export function upgradeBundledBrowserServer(server: ServerForm): boolean {
  if (!isBundledLumiBrowserServer(server))
    return false

  let changed = false
  const args = splitArgsText(server.argsText)
  const legacyArgumentIndex = legacyBundledBrowserArgumentIndex(server)
  if (legacyArgumentIndex >= 0) {
    args[legacyArgumentIndex] = `${LUMI_APP_PATH}/node_modules/@proj-airi/playwright-extra-mcp/dist/bin/run.mjs`
    server.argsText = args.join('\n')
    server.command = LUMI_EXEC_PATH
    server.cwd = LUMI_USER_DATA_PATH
    changed = true
  }

  const existing = new Map(server.envEntries.map(entry => [entry.key.trim(), entry.value]))
  const legacyProfile = existing.get('LUMI_PLAYWRIGHT_USER_DATA_DIR')
  const defaults = new Map<string, string>([
    ['ELECTRON_RUN_AS_NODE', '1'],
    ['LUMI_BROWSER_DEFAULT_BACKEND', 'patchright'],
    ['LUMI_BROWSER_FALLBACK_BACKEND', 'playwright'],
    ['LUMI_PATCHRIGHT_CHANNEL', 'chrome'],
    ['LUMI_PATCHRIGHT_HEADLESS', 'false'],
    ['LUMI_PATCHRIGHT_PERSISTENT_CONTEXT', 'true'],
    ['LUMI_PATCHRIGHT_NO_VIEWPORT', 'true'],
  ])
  if (legacyProfile)
    defaults.set('LUMI_BROWSER_PROFILE_PATH', legacyProfile)

  for (const [key, value] of defaults) {
    if (existing.has(key))
      continue
    server.envEntries.push({ key, value })
    changed = true
  }
  return changed
}

/** Creates a blank MCP server row for new entries. */
export function createServerForm(): ServerForm {
  return {
    rowId: makeRowId(),
    identifier: '',
    command: '',
    url: '',
    headersEntries: [],
    argsText: '',
    envEntries: [],
    cwd: '',
    enabled: true,
    startupMode: 'on_startup',
    longRunning: false,
    persistent: false,
    requestTimeoutMs: '',
    maxTotalTimeoutMs: '',
  }
}

export function createMinecraftMcpServerForm(): ServerForm {
  return {
    rowId: makeRowId(),
    identifier: 'minecraft',
    command: 'node',
    url: '',
    headersEntries: [],
    argsText: [
      'dist/main.js',
      '--host',
      'localhost',
      '--port',
      '25565',
      '--username',
      'LumiBot',
      '--version',
      '1.20.1',
      '--auth',
      'offline',
    ].join('\n'),
    envEntries: [],
    cwd: 'external-mcp/minecraft-mcp-server',
    enabled: true,
    startupMode: 'on_first_use',
    longRunning: true,
    persistent: true,
    requestTimeoutMs: '60000',
    maxTotalTimeoutMs: '180000',
  }
}

/** Creates the Windows Computer Use MCP row used by the normal MCP manager. */
export function createWindowsComputerUseMcpServerForm(): ServerForm {
  return {
    rowId: makeRowId(),
    identifier: 'computer_use',
    command: LUMI_EXEC_PATH,
    url: '',
    headersEntries: [],
    argsText: [
      `${LUMI_APP_PATH}/node_modules/@proj-airi/computer-use-mcp/dist/bin/run.mjs`,
    ].join('\n'),
    envEntries: [
      { key: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { key: 'COMPUTER_USE_EXECUTOR', value: 'windows-local' },
      { key: 'COMPUTER_USE_APPROVAL_MODE', value: 'never' },
      { key: 'COMPUTER_USE_MAX_OPERATIONS', value: '16' },
      { key: 'COMPUTER_USE_MAX_OPERATION_UNITS', value: '96' },
      { key: 'COMPUTER_USE_INTERRUPT_SHORTCUT', value: 'End' },
      { key: 'COMPUTER_USE_DENY_APPS', value: DEFAULT_COMPUTER_USE_DENY_APPS },
      { key: 'COMPUTER_USE_DENY_WINDOW_TITLES', value: '' },
      // Playwright is already the dedicated browser route for Lumi. Keeping this
      // bridge off prevents a second browser-control surface from competing with it.
      { key: 'COMPUTER_USE_BROWSER_DOM_BRIDGE_ENABLED', value: 'false' },
    ],
    cwd: LUMI_USER_DATA_PATH,
    enabled: true,
    startupMode: 'on_first_use',
    longRunning: true,
    persistent: true,
    requestTimeoutMs: '60000',
    maxTotalTimeoutMs: '180000',
  }
}

/** Creates Lumi's bundled dual-backend browser MCP row for browser inspection and actions. */
export function createPlaywrightMcpServerForm(): ServerForm {
  return {
    rowId: makeRowId(),
    identifier: 'playwright',
    command: LUMI_EXEC_PATH,
    url: '',
    headersEntries: [],
    argsText: [
      `${LUMI_APP_PATH}/node_modules/@proj-airi/playwright-extra-mcp/dist/bin/run.mjs`,
    ].join('\n'),
    envEntries: [
      { key: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { key: 'LUMI_BROWSER_DEFAULT_BACKEND', value: 'patchright' },
      { key: 'LUMI_BROWSER_FALLBACK_BACKEND', value: 'playwright' },
      { key: 'LUMI_BROWSER_PROFILE_PATH', value: `${LUMI_USER_DATA_PATH}/playwright-profile` },
      { key: 'LUMI_PATCHRIGHT_CHANNEL', value: 'chrome' },
      { key: 'LUMI_PATCHRIGHT_HEADLESS', value: 'false' },
      { key: 'LUMI_PATCHRIGHT_PERSISTENT_CONTEXT', value: 'true' },
      { key: 'LUMI_PATCHRIGHT_NO_VIEWPORT', value: 'true' },
      // Keep the legacy variable during this transition so existing profiles
      // remain at the same path when users switch between old and new builds.
      { key: 'LUMI_PLAYWRIGHT_USER_DATA_DIR', value: `${LUMI_USER_DATA_PATH}/playwright-profile` },
    ],
    cwd: LUMI_USER_DATA_PATH,
    enabled: true,
    startupMode: 'on_first_use',
    longRunning: true,
    persistent: true,
    requestTimeoutMs: '60000',
    maxTotalTimeoutMs: '180000',
  }
}

export const MCP_SERVER_PRESETS: McpServerPreset[] = [
  {
    id: 'minecraft',
    titleKey: 'add.presets-title',
    descriptionKey: 'add.minecraft-preset-description',
    icon: 'i-solar:gamepad-bold-duotone',
    actionLabelKey: 'actions.add-minecraft-preset',
    addedMessageKey: 'messages.minecraft-preset-added',
    create: createMinecraftMcpServerForm,
  },
  {
    id: 'computer_use',
    titleKey: 'add.computer-use-preset-title',
    descriptionKey: 'add.computer-use-preset-description',
    icon: 'i-solar:cursor-square-bold-duotone',
    actionLabelKey: 'actions.add-computer-use-preset',
    addedMessageKey: 'messages.computer-use-preset-added',
    create: createWindowsComputerUseMcpServerForm,
  },
  {
    id: 'playwright',
    titleKey: 'add.playwright-preset-title',
    descriptionKey: 'add.playwright-preset-description',
    icon: 'i-solar:global-line-duotone',
    actionLabelKey: 'actions.add-playwright-preset',
    addedMessageKey: 'messages.playwright-preset-added',
    create: createPlaywrightMcpServerForm,
  },
]

/** Resolves the persisted server identifier for a selected row. */
export function findServerIdentifierByRowId(servers: ServerForm[], rowId: string) {
  return servers.find(server => server.rowId === rowId)?.identifier.trim() || undefined
}

/** Converts one editable server row into persisted MCP server config. */
export function buildServerConfig(server: ServerForm): ElectronMcpStdioServerConfig {
  const config: ElectronMcpStdioServerConfig = {}

  if (server.command.trim())
    config.command = server.command.trim()

  if (server.url.trim())
    config.url = server.url.trim()

  const args = splitArgsText(server.argsText)
  if (args.length)
    config.args = args

  const env = envToObject(server.envEntries)
  if (Object.keys(env).length)
    config.env = env

  const headers = envToObject(server.headersEntries)
  if (Object.keys(headers).length)
    config.headers = headers

  if (server.cwd.trim())
    config.cwd = server.cwd.trim()

  if (!server.enabled)
    config.enabled = false

  if (server.startupMode !== 'on_startup')
    config.startupMode = server.startupMode

  if (server.longRunning)
    config.longRunning = true

  if (server.persistent)
    config.persistent = true

  const requestTimeoutMs = Number(server.requestTimeoutMs)
  if (Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0)
    config.requestTimeoutMs = Math.round(requestTimeoutMs)

  const maxTotalTimeoutMs = Number(server.maxTotalTimeoutMs)
  if (Number.isFinite(maxTotalTimeoutMs) && maxTotalTimeoutMs > 0)
    config.maxTotalTimeoutMs = Math.round(maxTotalTimeoutMs)

  return config
}

/** Builds the persisted MCP config file from editable rows. */
export function buildConfigFile(
  servers: ServerForm[],
  translateMessage: TranslateMcpMessage,
): ElectronMcpStdioConfigFile {
  const config: ElectronMcpStdioConfigFile = { mcpServers: {} }
  const seenIdentifiers = new Set<string>()

  for (const [index, server] of servers.entries()) {
    const identifier = server.identifier.trim()
    if (!identifier)
      throw new Error(translateMessage('errors.empty-identifier', { index: index + 1 }))

    if (seenIdentifiers.has(identifier))
      throw new Error(translateMessage('errors.duplicate-identifier', { name: identifier }))

    if (!server.command.trim() && !server.url.trim())
      throw new Error(translateMessage('errors.empty-command', { name: identifier }))

    seenIdentifiers.add(identifier)
    config.mcpServers[identifier] = buildServerConfig(server)
  }

  return config
}

/** Builds the JSON editor draft while preserving the current draft when form validation fails. */
export function syncJsonDraftFromServers(
  servers: ServerForm[],
  previousDraft: string,
  translateMessage: TranslateMcpMessage,
  formatError: (error: unknown) => string,
) {
  try {
    return {
      draft: `${JSON.stringify(buildConfigFile(servers, translateMessage), null, 2)}\n`,
      error: '',
    }
  }
  catch (error) {
    return {
      draft: previousDraft,
      error: formatError(error),
    }
  }
}

/** Loads editable rows from persisted MCP config. */
export function loadServerForms(
  config: ElectronMcpStdioConfigFile,
  options: { selectedIdentifier?: string } = {},
): LoadedServerForms {
  const upgradedBrowserServers: string[] = []
  const servers = Object.entries(config.mcpServers ?? {}).map(([identifier, server]) => {
    const form: ServerForm = {
      rowId: makeRowId(),
      identifier,
      command: server.command ?? '',
      url: server.url ?? '',
      headersEntries: Object.entries(server.headers ?? {}).map(([key, value]) => ({ key, value })),
      argsText: (server.args ?? []).join('\n'),
      envEntries: Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
      cwd: server.cwd ?? '',
      enabled: server.enabled !== false,
      startupMode: server.startupMode ?? 'on_startup',
      longRunning: server.longRunning === true,
      persistent: server.persistent === true,
      requestTimeoutMs: server.requestTimeoutMs ? String(server.requestTimeoutMs) : '',
      maxTotalTimeoutMs: server.maxTotalTimeoutMs ? String(server.maxTotalTimeoutMs) : '',
    }
    if (upgradeBundledBrowserServer(form))
      upgradedBrowserServers.push(identifier)
    return form
  })

  const selectedRowId = options.selectedIdentifier
    ? (servers.find(server => server.identifier === options.selectedIdentifier)?.rowId ?? servers[0]?.rowId ?? '')
    : (servers[0]?.rowId ?? '')

  return {
    servers,
    savedIds: new Set(servers.map(server => server.rowId)),
    selectedRowId,
    upgradedBrowserServers,
  }
}

/** Previews the command line assembled from one server row. */
export function previewServerCommand(server: ServerForm) {
  if (server.url.trim())
    return server.url.trim()

  return [server.command, ...splitArgsText(server.argsText)].join(' ')
}
