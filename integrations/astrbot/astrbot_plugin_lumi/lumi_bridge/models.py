from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal, TypeAlias


@dataclass(slots=True)
class LumiTextSegment:
    type: Literal["text"] = "text"
    text: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LumiImageSegment:
    type: Literal["image"] = "image"
    source_url: str | None = None
    local_path: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    data_base64: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LumiAudioSegment:
    type: Literal["audio"] = "audio"
    source_url: str | None = None
    local_path: str | None = None
    mime_type: str | None = None
    size_bytes: int | None = None
    duration_ms: int | None = None
    data_base64: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


LumiPerceptionSegment: TypeAlias = LumiTextSegment | LumiImageSegment | LumiAudioSegment


@dataclass(slots=True)
class LumiPerceptionEvent:
    event_id: str
    platform: str
    platform_instance_id: str
    unified_session_id: str
    conversation_id: str
    sender_id: str
    sender_name: str
    group_id: str | None
    message_id: str
    timestamp: int
    is_private: bool
    is_group: bool
    is_mention: bool
    segments: list[LumiPerceptionSegment]
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        payload = asdict(self)
        for segment in payload["segments"]:
            if segment["type"] in {"image", "audio"}:
                # Lumi Server receives the resolved bytes, not signed platform URLs
                # or filesystem paths from the AstrBot host.
                segment.pop("source_url", None)
                segment.pop("local_path", None)
        return payload


@dataclass(slots=True)
class LumiOutputSegment:
    type: Literal["text", "image", "audio", "file"]
    text: str | None = None
    url: str | None = None
    local_path: str | None = None
    mime_type: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LumiResponse:
    response_id: str
    text: str | None
    segments: list[LumiOutputSegment] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class LumiHealth:
    available: bool
    vision: bool
    hearing: bool
    version: str | None = None
    detail: str | None = None


@dataclass(slots=True)
class LumiSpeech:
    data: bytes
    mime_type: str
