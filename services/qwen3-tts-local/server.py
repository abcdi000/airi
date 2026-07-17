from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from typing import Any

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field


DEFAULT_MODEL = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
DEFAULT_LANGUAGE = "Chinese"
DEFAULT_VOICE_ID = "lumi_clone"
SENTENCE_BOUNDARY_RE = re.compile(r"([。！？!?；;]+|[\r\n]+)")
logger = logging.getLogger("lumi.qwen3_tts_local")


class SpeechRequest(BaseModel):
    model: str = DEFAULT_MODEL
    input: str
    voice: str = DEFAULT_VOICE_ID
    response_format: str = Field(default="wav")
    extra_body: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class ClonePromptKey:
    model_id: str
    ref_audio: str
    ref_text: str
    x_vector_only_mode: bool


class Qwen3TtsEngine:
    def __init__(self) -> None:
        self._models: dict[str, Any] = {}
        self._clone_prompts: dict[ClonePromptKey, Any] = {}
        self._lock = threading.RLock()

    def available(self) -> tuple[bool, str]:
        if importlib.util.find_spec("qwen_tts") is None:
            return False, "qwen_tts is not installed"
        return True, "qwen_tts is installed"

    def _normalize_model_id(self, model_id: str | None) -> str:
        raw = (model_id or DEFAULT_MODEL).strip()
        if "/" in raw:
            return raw
        return f"Qwen/{raw}"

    def _load_model(self, model_id: str) -> Any:
        model_id = self._normalize_model_id(model_id)
        with self._lock:
            if model_id in self._models:
                return self._models[model_id]

            import torch
            from huggingface_hub import hf_hub_download, snapshot_download
            from qwen_tts import Qwen3TTSModel

            snapshot_download(
                repo_id=model_id,
                allow_patterns=[
                    "config.json",
                    "generation_config.json",
                    "merges.txt",
                    "model.safetensors",
                    "preprocessor_config.json",
                    "tokenizer_config.json",
                    "vocab.json",
                    "speech_tokenizer/config.json",
                    "speech_tokenizer/configuration.json",
                    "speech_tokenizer/model.safetensors",
                    "speech_tokenizer/preprocessor_config.json",
                ],
            )
            for filename in [
                "speech_tokenizer/config.json",
                "speech_tokenizer/configuration.json",
                "speech_tokenizer/model.safetensors",
                "speech_tokenizer/preprocessor_config.json",
            ]:
                hf_hub_download(repo_id=model_id, filename=filename)

            has_cuda = torch.cuda.is_available()
            dtype = torch.bfloat16 if has_cuda and torch.cuda.is_bf16_supported() else torch.float16 if has_cuda else torch.float32
            kwargs: dict[str, Any] = {
                "dtype": dtype,
            }
            if has_cuda:
                kwargs["device_map"] = os.getenv("QWEN3_TTS_DEVICE", "cuda:0")
                attn = os.getenv("QWEN3_TTS_ATTN", "sdpa").strip()
                if attn:
                    kwargs["attn_implementation"] = attn
            else:
                kwargs["device_map"] = "cpu"

            model = Qwen3TTSModel.from_pretrained(model_id, **kwargs)
            self._models[model_id] = model
            return model

    def synthesize(self, text: str, model_id: str, extra_body: dict[str, Any] | None = None) -> tuple[np.ndarray, int]:
        source = text.strip()
        if not source:
            raise ValueError("input text is empty")

        extra = extra_body or {}
        model_id = self._normalize_model_id(model_id)
        model = self._load_model(model_id)
        language = str(extra.get("language") or DEFAULT_LANGUAGE)

        if "CustomVoice" in model_id:
            wavs, sr = model.generate_custom_voice(
                text=source,
                language=language,
                speaker=str(extra.get("speaker") or "Serena"),
                instruct=str(extra.get("instruct") or ""),
            )
            return np.asarray(wavs[0]), int(sr)

        if "VoiceDesign" in model_id:
            wavs, sr = model.generate_voice_design(
                text=source,
                language=language,
                instruct=str(extra.get("instruct") or ""),
            )
            return np.asarray(wavs[0]), int(sr)

        ref_audio = str(extra.get("ref_audio") or extra.get("refAudio") or "").strip()
        ref_text = str(extra.get("ref_text") or extra.get("refText") or "").strip()
        x_vector_only_mode = bool(extra.get("x_vector_only_mode") or extra.get("xVectorOnlyMode"))
        if not ref_audio:
            raise ValueError("voice clone model requires ref_audio/refAudio")

        prompt_key = ClonePromptKey(model_id, ref_audio, ref_text, x_vector_only_mode)
        with self._lock:
            prompt = self._clone_prompts.get(prompt_key)
            if prompt is None:
                prompt = model.create_voice_clone_prompt(
                    ref_audio=ref_audio,
                    ref_text=ref_text,
                    x_vector_only_mode=x_vector_only_mode,
                )
                self._clone_prompts[prompt_key] = prompt

        wavs, sr = model.generate_voice_clone(
            text=source,
            language=language,
            voice_clone_prompt=prompt,
        )
        return np.asarray(wavs[0]), int(sr)


engine = Qwen3TtsEngine()
app = FastAPI(title="Lumi Qwen3-TTS Local Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def wav_bytes(wav: np.ndarray, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    sf.write(buffer, wav, sample_rate, format="WAV")
    return buffer.getvalue()


def extract_complete_sentence(buffer: str, force: bool = False) -> tuple[str | None, str]:
    text = buffer.lstrip()
    if not text:
        return None, ""

    match = SENTENCE_BOUNDARY_RE.search(text)
    if match and match.end() >= 8:
        return text[:match.end()].strip(), text[match.end():]

    if force:
        return text.strip(), ""

    return None, text


@app.get("/v1/health")
def health() -> dict[str, Any]:
    ok, message = engine.available()
    return {
        "ok": ok,
        "message": message,
        "models_loaded": list(engine._models.keys()),
        "clone_prompts_cached": len(engine._clone_prompts),
    }


@app.get("/v1/audio/models")
def list_models() -> dict[str, Any]:
    return {
        "models": [
            {
                "id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
                "name": "Qwen3-TTS 0.6B Base (Voice Clone)",
                "description": "Laptop-friendly voice clone model.",
            },
            {
                "id": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
                "name": "Qwen3-TTS 1.7B Base (Voice Clone)",
                "description": "Higher quality, higher latency and VRAM use.",
            },
            {
                "id": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
                "name": "Qwen3-TTS 0.6B Custom Voice",
                "description": "Preset voice model for quick tests.",
            },
            {
                "id": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
                "name": "Qwen3-TTS 1.7B Custom Voice",
                "description": "Higher quality preset voice model.",
            },
        ]
    }


@app.get("/v1/audio/voices")
def list_voices() -> dict[str, Any]:
    return {
        "voices": [
            {
                "id": DEFAULT_VOICE_ID,
                "name": "Lumi Clone",
                "description": "Voice clone configured by reference audio in AIRI settings.",
            },
            {
                "id": "Serena",
                "name": "Serena",
                "description": "Qwen3-TTS preset speaker for CustomVoice models.",
            },
            {
                "id": "Vivian",
                "name": "Vivian",
                "description": "Qwen3-TTS preset speaker for CustomVoice models.",
            },
        ]
    }


@app.post("/v1/audio/speech")
async def create_speech(req: SpeechRequest) -> Response:
    try:
        wav, sr = await asyncio.to_thread(engine.synthesize, req.input, req.model, req.extra_body)
        return Response(wav_bytes(wav, sr), media_type="audio/wav")
    except Exception as exc:
        logger.exception("Qwen3-TTS REST synthesis failed")
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.websocket("/v1/audio/speech/ws")
async def speech_ws(ws: WebSocket) -> None:
    await ws.accept()
    model = DEFAULT_MODEL
    voice = DEFAULT_VOICE_ID
    extra_body: dict[str, Any] = {}
    buffer = ""
    sentence_index = 0
    connected = True

    async def safe_send_text(payload: dict[str, Any]) -> bool:
        nonlocal connected
        if not connected:
            return False
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
            return True
        except (WebSocketDisconnect, RuntimeError):
            connected = False
            return False

    async def safe_send_bytes(payload: bytes) -> bool:
        nonlocal connected
        if not connected:
            return False
        try:
            await ws.send_bytes(payload)
            return True
        except (WebSocketDisconnect, RuntimeError):
            connected = False
            return False

    async def safe_close() -> None:
        nonlocal connected
        if not connected:
            return
        connected = False
        try:
            await ws.close()
        except (WebSocketDisconnect, RuntimeError):
            return

    async def safe_receive_text() -> str | None:
        nonlocal connected
        if not connected:
            return None
        try:
            return await ws.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            connected = False
            return None

    async def synthesize_and_send(sentence: str) -> None:
        nonlocal sentence_index
        if not sentence.strip():
            return
        index = sentence_index
        sentence_index += 1
        if not await safe_send_text({
            "event": "sentence.start",
            "payload": {"index": index, "text": sentence},
        }):
            return
        wav, sr = await asyncio.to_thread(engine.synthesize, sentence, model, extra_body)
        if not await safe_send_bytes(wav_bytes(wav, sr)):
            return
        await safe_send_text({
            "event": "sentence.end",
            "payload": {"index": index, "text": sentence},
        })

    try:
        while True:
            raw = await safe_receive_text()
            if raw is None:
                return
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue

            kind = event.get("event")
            if kind == "start":
                model = str(event.get("model") or DEFAULT_MODEL)
                voice = str(event.get("voice") or DEFAULT_VOICE_ID)
                incoming_extra = event.get("extra_body")
                extra_body = incoming_extra if isinstance(incoming_extra, dict) else {}
                extra_body.setdefault("voice", voice)
                await safe_send_text({"event": "session.started"})
                continue

            if kind == "text":
                buffer += str(event.get("text") or "")
                while True:
                    sentence, buffer = extract_complete_sentence(buffer)
                    if not sentence:
                        break
                    await synthesize_and_send(sentence)
                    if not connected:
                        return
                continue

            if kind == "finish":
                sentence, buffer = extract_complete_sentence(buffer, force=True)
                if sentence:
                    await synthesize_and_send(sentence)
                if not connected:
                    return
                await safe_send_text({"event": "session.finished"})
                await safe_close()
                return

            if kind == "cancel":
                await safe_close()
                return
    except WebSocketDisconnect:
        return
    except Exception as exc:
        logger.exception("Qwen3-TTS websocket synthesis failed")
        await safe_send_text({
            "event": "error",
            "code": "qwen3_tts_local_error",
            "message": str(exc),
        })
        await safe_close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("QWEN3_TTS_PORT", "8766")))
