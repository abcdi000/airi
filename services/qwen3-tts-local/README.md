# Lumi Qwen3-TTS Local Service

This is an optional local TTS sidecar for AIRI/Lumi. It does not replace MiMo.
Only the `qwen3-tts-local` speech provider uses this service.

## Recommended Environment

Use a separate conda environment so Qwen3-TTS dependencies do not pollute the AIRI
runtime environment.

```powershell
conda create -n qwen3-tts python=3.12 -y
conda run -n qwen3-tts python -m pip install -U pip
conda run -n qwen3-tts python -m pip install -r services\qwen3-tts-local\requirements-qwen3-tts.txt
```

For NVIDIA GPU acceleration, install the PyTorch CUDA build that matches your
driver before installing or running the service. For a 5070 Ti Laptop, prefer a
recent CUDA 12.x PyTorch build.

## Start

```powershell
conda run -n qwen3-tts python services\qwen3-tts-local\server.py
```

or run from this service directory:

```powershell
cd services\qwen3-tts-local
conda run -n qwen3-tts python -m uvicorn server:app --host 127.0.0.1 --port 8766
```

The provider expects:

```text
http://127.0.0.1:8766/v1/
```

## Endpoints

- `GET /v1/health`
- `GET /v1/audio/models`
- `GET /v1/audio/voices`
- `POST /v1/audio/speech`
- `WS /v1/audio/speech/ws`

The WebSocket endpoint implements the same simple bidirectional event protocol
used by AIRI's streaming TTS pipeline. It synthesizes completed sentence chunks
as soon as punctuation arrives, then flushes the remaining text on `finish`.
