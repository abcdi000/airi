from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, cast
from urllib.parse import urlparse

TriggerMode = Literal[
    "private_always", "wake_only", "mention_only", "all_messages", "disabled"
]
FailurePolicy = Literal["silent", "friendly_error", "allow_default_llm_fallback"]
TempFileRetention = Literal["delete", "keep_on_error", "keep"]
LumiTarget = Literal["desktop_local", "server"]
VoiceReplyMode = Literal["all_text", "all_voice", "random", "mirror_input_audio"]

@dataclass(frozen=True, slots=True)
class LumiPluginConfig:
    enabled: bool
    lumi_target: LumiTarget
    lumi_endpoint: str
    lumi_api_token: str
    speech_endpoint: str
    speech_api_token: str
    request_timeout_seconds: float
    connect_timeout_seconds: float
    trigger_mode: TriggerMode
    private_reply_enabled: bool
    group_observation_enabled: bool
    wake_words: tuple[str, ...]
    ignore_command_messages: bool
    command_prefixes: tuple[str, ...]
    max_image_bytes: int
    max_audio_bytes: int
    max_audio_duration_seconds: int
    ffmpeg_path: str
    audio_conversion_timeout_seconds: float
    media_download_timeout_seconds: float
    temp_file_retention: TempFileRetention
    allow_default_llm_fallback: bool
    enable_vision: bool
    enable_hearing: bool
    prefer_qq_native_transcription: bool
    failure_policy: FailurePolicy
    log_level: str
    voice_reply_mode: VoiceReplyMode
    random_voice_probability: float

    @classmethod
    def from_mapping(cls, raw: dict[str, Any]) -> "LumiPluginConfig":
        target = str(raw.get("lumi_target", "server"))
        if target not in {"desktop_local", "server"}:
            raise ValueError(f"unsupported lumi_target: {target}")
        default_endpoint = (
            "http://127.0.0.1:6132"
            if target == "desktop_local"
            else "http://127.0.0.1:6130"
        )
        endpoint = str(raw.get("lumi_endpoint", default_endpoint)).rstrip("/")
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("lumi_endpoint must be an HTTP or HTTPS URL")
        if parsed.scheme == "http" and parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError("remote Lumi endpoints must use HTTPS")
        speech_endpoint = str(
            raw.get(
                "speech_endpoint",
                endpoint if target == "desktop_local" else "http://127.0.0.1:6132",
            )
        ).rstrip("/")
        speech_parsed = urlparse(speech_endpoint)
        if speech_parsed.scheme not in {"http", "https"} or not speech_parsed.netloc:
            raise ValueError("speech_endpoint must be an HTTP or HTTPS URL")
        if speech_parsed.scheme == "http" and speech_parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError("remote speech endpoints must use HTTPS")

        trigger_mode = str(raw.get("trigger_mode", "private_always"))
        if trigger_mode not in {
            "private_always",
            "wake_only",
            "mention_only",
            "all_messages",
            "disabled",
        }:
            raise ValueError(f"unsupported trigger_mode: {trigger_mode}")
        failure_policy = str(raw.get("failure_policy", "friendly_error"))
        if failure_policy not in {
            "silent",
            "friendly_error",
            "allow_default_llm_fallback",
        }:
            raise ValueError(f"unsupported failure_policy: {failure_policy}")
        retention = str(raw.get("temp_file_retention", "delete"))
        if retention not in {"delete", "keep_on_error", "keep"}:
            raise ValueError(f"unsupported temp_file_retention: {retention}")
        voice_reply_mode = str(raw.get("voice_reply_mode", "all_text"))
        if voice_reply_mode not in {
            "all_text",
            "all_voice",
            "random",
            "mirror_input_audio",
        }:
            raise ValueError(f"unsupported voice_reply_mode: {voice_reply_mode}")
        random_voice_probability = float(raw.get("random_voice_probability", 0.35))
        if not 0 <= random_voice_probability <= 1:
            raise ValueError("random_voice_probability must be between 0 and 1")

        return cls(
            enabled=bool(raw.get("enabled", True)),
            lumi_target=cast(LumiTarget, target),
            lumi_endpoint=endpoint,
            lumi_api_token=str(raw.get("lumi_api_token", "")).strip(),
            speech_endpoint=speech_endpoint,
            speech_api_token=str(
                raw.get("speech_api_token", raw.get("lumi_api_token", ""))
            ).strip(),
            request_timeout_seconds=_positive_float(
                raw.get("request_timeout_seconds", 120), "request_timeout_seconds"
            ),
            connect_timeout_seconds=_positive_float(
                raw.get("connect_timeout_seconds", 10), "connect_timeout_seconds"
            ),
            trigger_mode=cast(TriggerMode, trigger_mode),
            private_reply_enabled=bool(
                raw.get(
                    "private_reply_enabled",
                    raw.get("handle_private_messages", True),
                )
            ),
            group_observation_enabled=bool(
                raw.get("group_observation_enabled", True)
            ),
            wake_words=_strings(raw.get("wake_words", ["Lumi", "lumi"])),
            ignore_command_messages=bool(raw.get("ignore_command_messages", True)),
            command_prefixes=_strings(raw.get("command_prefixes", ["/"])),
            max_image_bytes=_positive_int(
                raw.get("max_image_bytes", 10 * 1024 * 1024), "max_image_bytes"
            ),
            max_audio_bytes=_positive_int(
                raw.get("max_audio_bytes", 25 * 1024 * 1024), "max_audio_bytes"
            ),
            max_audio_duration_seconds=_positive_int(
                raw.get("max_audio_duration_seconds", 300),
                "max_audio_duration_seconds",
            ),
            ffmpeg_path=str(raw.get("ffmpeg_path", "ffmpeg")).strip() or "ffmpeg",
            audio_conversion_timeout_seconds=_positive_float(
                raw.get("audio_conversion_timeout_seconds", 60),
                "audio_conversion_timeout_seconds",
            ),
            media_download_timeout_seconds=_positive_float(
                raw.get("media_download_timeout_seconds", 30),
                "media_download_timeout_seconds",
            ),
            temp_file_retention=cast(TempFileRetention, retention),
            allow_default_llm_fallback=bool(
                raw.get("allow_default_llm_fallback", False)
            ),
            enable_vision=bool(raw.get("enable_vision", True)),
            enable_hearing=bool(raw.get("enable_hearing", True)),
            prefer_qq_native_transcription=bool(
                raw.get("prefer_qq_native_transcription", True)
            ),
            failure_policy=cast(FailurePolicy, failure_policy),
            log_level=str(raw.get("log_level", "INFO")).upper(),
            voice_reply_mode=cast(VoiceReplyMode, voice_reply_mode),
            random_voice_probability=random_voice_probability,
        )

    def should_reply_with_voice(
        self, *, input_has_audio: bool, random_value: float
    ) -> bool:
        if self.voice_reply_mode == "all_voice":
            return True
        if self.voice_reply_mode == "random":
            return random_value < self.random_voice_probability
        if self.voice_reply_mode == "mirror_input_audio":
            return input_has_audio
        return False


def _positive_int(value: Any, name: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise ValueError(f"{name} must be positive")
    return parsed


def _positive_float(value: Any, name: str) -> float:
    parsed = float(value)
    if parsed <= 0:
        raise ValueError(f"{name} must be positive")
    return parsed


def _strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(str(item).strip() for item in value if str(item).strip())
