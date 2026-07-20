import process from 'node:process'

import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { errorMessageFrom } from '@moeru/std'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const APP_DIR = resolve(SCRIPT_DIR, '..')
const REPO_DIR = resolve(APP_DIR, '..', '..')

const DEFAULT_PYTHON_VERSION = '3.11.9'
const PYTHON_VERSION = valueFromArg('--python-version') ?? process.env.LUMI_VECTOR_PYTHON_VERSION ?? DEFAULT_PYTHON_VERSION
const PYTHON_ARCH = process.env.LUMI_VECTOR_PYTHON_ARCH ?? 'amd64'
const PYTHON_ZIP_URL = process.env.LUMI_VECTOR_PYTHON_ZIP_URL
  ?? `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-${PYTHON_ARCH}.zip`
const GET_PIP_URL = process.env.LUMI_VECTOR_GET_PIP_URL
  ?? 'https://bootstrap.pypa.io/get-pip.py'

const RUNTIME_DIR = resolve(APP_DIR, 'resources', 'python')
const MODEL_CACHE_DIR = resolve(APP_DIR, 'resources', 'vector-model-cache')
const CACHE_DIR = resolve(APP_DIR, '.cache', 'vector-python-runtime')
const PYTHON_ZIP_PATH = join(CACHE_DIR, `python-${PYTHON_VERSION}-embed-${PYTHON_ARCH}.zip`)
const GET_PIP_PATH = join(CACHE_DIR, 'get-pip.py')
const REQUIREMENTS_PATH = resolve(REPO_DIR, 'services', 'lumi-memory-vector', 'requirements.txt')
const READY_MARKER_PATH = join(RUNTIME_DIR, '.lumi-vector-runtime.json')
const MODEL_ID = process.env.LUMI_MEMORY_EMBEDDING_MODEL ?? 'BAAI/bge-small-zh-v1.5'
const TORCH_SPEC = process.env.LUMI_VECTOR_TORCH_SPEC ?? 'torch>=2.2,<3'
const TORCH_VARIANT = process.env.LUMI_VECTOR_TORCH_VARIANT ?? 'cuda'
const TORCH_CUDA_FLAVOR = process.env.LUMI_VECTOR_TORCH_CUDA_FLAVOR ?? 'cu130'
const TORCH_INDEX_URL = process.env.LUMI_VECTOR_TORCH_INDEX_URL ?? defaultTorchIndexUrl()

interface RuntimeMarker {
  model: string
  pythonArch: string
  pythonVersion: string
  torchIndexUrl: string
  torchSpec: string
  torchVariant: string
}

/**
 * Prepares Lumi's private Python vector runtime.
 *
 * Use when:
 * - Building the Windows desktop installer.
 * - Preparing the unpacked app for install-like testing.
 *
 * Expects:
 * - Windows when the runtime is required.
 * - Network access on the first run, unless cached files already exist.
 *
 * Returns:
 * - A populated `apps/stage-tamagotchi/resources/python` runtime.
 *
 * Call stack:
 *
 * main
 *   -> {@link prepareRuntime}
 *     -> {@link ensureEmbeddablePython}
 *       -> {@link installPythonDependencies}
 *       -> {@link prepareModelCache}
 */
async function main() {
  if (process.env.LUMI_SKIP_VECTOR_PYTHON_RUNTIME === '1' || hasArg('--skip')) {
    console.warn('[lumi-vector-runtime] skipped by LUMI_SKIP_VECTOR_PYTHON_RUNTIME/--skip')
    return
  }

  if (process.platform !== 'win32') {
    const message = `[lumi-vector-runtime] Windows private Python runtime is skipped on ${process.platform}.`
    if (process.env.LUMI_REQUIRE_VECTOR_PYTHON_RUNTIME === '1')
      throw new Error(message)
    console.warn(message)
    return
  }

  await prepareRuntime()
}

async function prepareRuntime() {
  const force = hasArg('--force') || process.env.LUMI_FORCE_VECTOR_PYTHON_RUNTIME === '1'
  if (!force && isRuntimeReady()) {
    console.warn(`[lumi-vector-runtime] existing runtime is ready: ${RUNTIME_DIR}`)
    return
  }

  if (force) {
    await rm(RUNTIME_DIR, { recursive: true, force: true })
    await rm(MODEL_CACHE_DIR, { recursive: true, force: true })
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await ensureEmbeddablePython()
  patchPythonPathFile()

  if (!hasArg('--skip-deps') && process.env.LUMI_VECTOR_RUNTIME_SKIP_DEPS !== '1') {
    await ensurePip()
    if (process.env.LUMI_VECTOR_RUNTIME_SKIP_TORCH !== '1' && process.env.LUMI_VECTOR_RUNTIME_SKIP_TORCH_CPU !== '1')
      installTorchDependency()
    installPythonDependencies()
  }

  if (!hasArg('--skip-model') && process.env.LUMI_VECTOR_RUNTIME_SKIP_MODEL !== '1')
    prepareModelCache()

  await writeFile(READY_MARKER_PATH, `${JSON.stringify({
    pythonVersion: PYTHON_VERSION,
    pythonArch: PYTHON_ARCH,
    model: MODEL_ID,
    torchIndexUrl: TORCH_INDEX_URL,
    torchSpec: TORCH_SPEC,
    torchVariant: TORCH_VARIANT,
    preparedAt: new Date().toISOString(),
  }, null, 2)}\n`)
  console.warn(`[lumi-vector-runtime] ready: ${RUNTIME_DIR}`)
}

function isRuntimeReady() {
  const marker = readRuntimeMarker()
  return existsSync(READY_MARKER_PATH)
    && existsSync(join(RUNTIME_DIR, 'python.exe'))
    && existsSync(join(RUNTIME_DIR, 'Lib', 'site-packages', 'sentence_transformers'))
    && marker?.pythonVersion === PYTHON_VERSION
    && marker.pythonArch === PYTHON_ARCH
    && marker.model === MODEL_ID
    && marker.torchIndexUrl === TORCH_INDEX_URL
    && marker.torchSpec === TORCH_SPEC
    && marker.torchVariant === TORCH_VARIANT
}

async function ensureEmbeddablePython() {
  await downloadIfMissing(PYTHON_ZIP_URL, PYTHON_ZIP_PATH)
  await mkdir(RUNTIME_DIR, { recursive: true })
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '& { param($zipPath, $destinationPath) Expand-Archive -LiteralPath $zipPath -DestinationPath $destinationPath -Force }',
    PYTHON_ZIP_PATH,
    RUNTIME_DIR,
  ])
}

function patchPythonPathFile() {
  const pthFile = findPythonPathFile()
  const original = readTextSync(pthFile)
  const lines = original.split(/\r?\n/)
  const normalized = new Set(lines.map(line => line.trim()))
  const next = lines.map(line => line.trim() === '#import site' ? 'import site' : line)

  if (!normalized.has('Lib/site-packages')) {
    const importSiteIndex = next.findIndex(line => line.trim() === 'import site')
    if (importSiteIndex >= 0)
      next.splice(importSiteIndex, 0, 'Lib/site-packages')
    else
      next.push('Lib/site-packages')
  }

  if (!next.some(line => line.trim() === 'import site'))
    next.push('import site')

  writeTextSync(pthFile, `${next.join('\n').replace(/\n+$/, '')}\n`)
}

function findPythonPathFile() {
  const majorMinor = PYTHON_VERSION.split('.').slice(0, 2).join('')
  const preferred = join(RUNTIME_DIR, `python${majorMinor}._pth`)
  if (existsSync(preferred))
    return preferred

  const fallback = join(RUNTIME_DIR, 'python._pth')
  if (existsSync(fallback))
    return fallback

  throw new Error(`Python ._pth file was not found in ${RUNTIME_DIR}`)
}

async function ensurePip() {
  await downloadIfMissing(GET_PIP_URL, GET_PIP_PATH)
  run(pythonExe(), [GET_PIP_PATH, '--no-warn-script-location'], {
    PYTHONNOUSERSITE: '1',
  })
}

function installPythonDependencies() {
  const extraArgs = splitArgs(process.env.LUMI_VECTOR_PIP_EXTRA_ARGS)
  run(pythonExe(), [
    '-m',
    'pip',
    'install',
    '--no-warn-script-location',
    '--prefer-binary',
    ...extraArgs,
    '-r',
    REQUIREMENTS_PATH,
  ], {
    PYTHONNOUSERSITE: '1',
  })
}

function installTorchDependency() {
  const extraArgs = splitArgs(process.env.LUMI_VECTOR_TORCH_PIP_EXTRA_ARGS)
  run(pythonExe(), [
    '-m',
    'pip',
    'install',
    '--no-warn-script-location',
    '--prefer-binary',
    '--index-url',
    TORCH_INDEX_URL,
    ...extraArgs,
    TORCH_SPEC,
  ], {
    PYTHONNOUSERSITE: '1',
  })
}

function prepareModelCache() {
  const code = `
from sentence_transformers import SentenceTransformer
model = SentenceTransformer(${JSON.stringify(MODEL_ID)}, cache_folder=${JSON.stringify(MODEL_CACHE_DIR)})
model.encode(["Lumi vector runtime smoke test"], normalize_embeddings=True, show_progress_bar=False)
print("model-ready")
`
  run(pythonExe(), ['-c', code], {
    HF_HOME: MODEL_CACHE_DIR,
    SENTENCE_TRANSFORMERS_HOME: MODEL_CACHE_DIR,
    TRANSFORMERS_CACHE: join(MODEL_CACHE_DIR, 'transformers'),
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
    TQDM_DISABLE: '1',
    PYTHONNOUSERSITE: '1',
  })
}

async function downloadIfMissing(url: string, destination: string) {
  if (existsSync(destination)) {
    console.warn(`[lumi-vector-runtime] using cached ${destination}`)
    return
  }

  await mkdir(dirname(destination), { recursive: true })
  console.warn(`[lumi-vector-runtime] downloading ${url}`)
  const temporaryDestination = `${destination}.tmp`
  await rm(temporaryDestination, { force: true })
  const response = await fetch(url)
  if (!response.ok || !response.body)
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)

  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryDestination))
  await rename(temporaryDestination, destination)
}

function pythonExe() {
  return join(RUNTIME_DIR, 'python.exe')
}

function run(command: string, args: string[], env: Record<string, string> = {}) {
  console.warn(`[lumi-vector-runtime] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: APP_DIR,
    env: {
      ...process.env,
      ...env,
    },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error)
    throw result.error
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`)
}

function splitArgs(value: string | undefined) {
  if (!value)
    return []
  return value.match(/"[^"]+"|'[^']+'|\S+/g)?.map(part => part.replace(/^["']|["']$/g, '')) ?? []
}

function hasArg(name: string) {
  return process.argv.includes(name)
}

function valueFromArg(name: string) {
  const prefix = `${name}=`
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

function readRuntimeMarker(): RuntimeMarker | undefined {
  if (!existsSync(READY_MARKER_PATH))
    return undefined

  try {
    const marker = JSON.parse(readTextSync(READY_MARKER_PATH))
    if (!marker || typeof marker !== 'object')
      return undefined

    return marker as RuntimeMarker
  }
  catch (error) {
    console.warn(`[lumi-vector-runtime] ignored invalid runtime marker: ${errorMessageFrom(error)}`)
    return undefined
  }
}

function defaultTorchIndexUrl() {
  if (TORCH_VARIANT === 'cpu')
    return 'https://download.pytorch.org/whl/cpu'

  if (TORCH_VARIANT === 'cuda')
    return `https://download.pytorch.org/whl/${TORCH_CUDA_FLAVOR}`

  return `https://download.pytorch.org/whl/${TORCH_VARIANT}`
}

function readTextSync(path: string) {
  return readFileSync(path, 'utf8')
}

function writeTextSync(path: string, text: string) {
  writeFileSync(path, text)
}

main().catch((error) => {
  console.error(`[lumi-vector-runtime] failed: ${errorMessageFrom(error)}`)
  process.exitCode = 1
})
