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
LumiGroupObservationSegment: TypeAlias = LumiTextSegment | LumiImageSegment


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
class LumiGroupObservationEvent:
    """A read-only group input that cannot carry any reply capability."""

    event_id: str
    message_id: str
    source_id: str
    group_id: str
    platform: str
    platform_instance_id: str
    sender_id: str
    sender_name: str
    timestamp: int
    segments: list[LumiGroupObservationSegment]
    author_verified: bool = True
    is_lumi: bool = False
    source_kind: Literal["human_message"] = "human_message"
    conversation_type: Literal["group_observation"] = "group_observation"
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["is_private"] = False
        payload["is_group"] = True
        for segment in payload["segments"]:
            if segment["type"] == "image":
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
    data_base64: str | None = None
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


@dataclass(frozen=True, slots=True)
class LumiStudyGroup:
    source_id: str
    platform_instance_id: str
    group_id: str
    priority: Literal["normal", "high"]


@dataclass(frozen=True, slots=True)
class LumiLearningPolicy:
    private_reply_enabled: bool
    group_observation_enabled: bool
    groups: tuple[LumiStudyGroup, ...]

    def source_for(self, platform_instance_id: str, group_id: str) -> LumiStudyGroup | None:
        return next(
            (
                group
                for group in self.groups
                if group.platform_instance_id == platform_instance_id
                and group.group_id == group_id
            ),
            None,
        )
