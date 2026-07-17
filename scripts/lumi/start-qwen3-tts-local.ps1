param(
  [string]$CondaEnv = "qwen3-tts",
  [int]$Port = 8766
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$serviceDir = Join-Path $repoRoot "services\qwen3-tts-local"

$condaBase = (& conda info --base).Trim()
$pythonExe = Join-Path $condaBase "envs\$CondaEnv\python.exe"
if (-not (Test-Path -LiteralPath $pythonExe)) {
  throw "Cannot find Python for conda env '$CondaEnv': $pythonExe"
}

$env:NO_PROXY = "127.0.0.1,localhost,$env:NO_PROXY"
$env:no_proxy = "127.0.0.1,localhost,$env:no_proxy"

Write-Host "Starting Lumi Qwen3-TTS Local Service on http://127.0.0.1:$Port/v1/"
Write-Host "Using Python: $pythonExe"
Write-Host "First synthesis may download and load Qwen3-TTS model weights."

& $pythonExe -m uvicorn server:app --host 127.0.0.1 --port $Port --app-dir $serviceDir --log-level info
