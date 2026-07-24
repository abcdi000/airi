from __future__ import annotations

from pathlib import Path

import httpx

from .astrbot_adapter import AstrBotEventAdapter
from .client import HttpLumiRuntimeClient
from .config import LumiPluginConfig
from .identity import PlatformIdentityMapper
from .media import AudioResolver, ImageResolver, MediaResolver
from .session import SessionCoordinator


class LumiBridgeService:
    def __init__(self, config: LumiPluginConfig, temp_directory: Path) -> None:
        self.config = config
        self.temp_directory = temp_directory
        self.http_client = httpx.AsyncClient()
        media = MediaResolver(
            self.http_client,
            temp_directory,
            config.media_download_timeout_seconds,
        )
        self.adapter = AstrBotEventAdapter(
            PlatformIdentityMapper(),
            ImageResolver(media, config.max_image_bytes),
            AudioResolver(
                media,
                config.max_audio_bytes,
                config.max_audio_duration_seconds * 1000,
                temp_directory,
                config.ffmpeg_path,
                config.audio_conversion_timeout_seconds,
            ),
            config.wake_words,
            config.enable_vision,
            config.enable_hearing,
            config.prefer_qq_native_transcription,
        )
        self.client = HttpLumiRuntimeClient(
            config.lumi_endpoint,
            config.lumi_api_token,
            config.request_timeout_seconds,
            config.connect_timeout_seconds,
        )
        self.speech_client = HttpLumiRuntimeClient(
            config.speech_endpoint,
            config.speech_api_token,
            config.request_timeout_seconds,
            config.connect_timeout_seconds,
        )
        self.sessions = SessionCoordinator()

    async def close(self) -> None:
        await self.sessions.close()
        await self.client.close()
        await self.speech_client.close()
        await self.http_client.aclose()
