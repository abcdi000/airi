from __future__ import annotations

from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from astrbot.api import message_components as Comp
from astrbot.api.event import AstrMessageEvent

from .identity import IdentityMapper
from .media import AudioResolver, ImageResolver, MediaReference
from .models import LumiPerceptionEvent, LumiTextSegment
from .routing import RoutingFacts


class AstrBotEventAdapter:
    """Converts the current AstrBot message-chain API into one ordered Lumi event."""

    def __init__(
        self,
        identity_mapper: IdentityMapper,
        image_resolver: ImageResolver,
        audio_resolver: AudioResolver,
        wake_words: tuple[str, ...],
        enable_vision: bool,
        enable_hearing: bool,
        prefer_qq_native_transcription: bool,
    ) -> None:
        self._identity_mapper = identity_mapper
        self._image_resolver = image_resolver
        self._audio_resolver = audio_resolver
        self._wake_words = tuple(word.casefold() for word in wake_words)
        self._enable_vision = enable_vision
        self._enable_hearing = enable_hearing
        self._prefer_qq_native_transcription = prefer_qq_native_transcription

    def routing_facts(self, event: AstrMessageEvent) -> RoutingFacts:
        sender_id = event.get_sender_id()
        self_id = event.get_self_id()
        message_type = event.get_message_type().value
        messages = event.get_messages()
        text = "".join(
            segment.text
            for segment in messages
            if isinstance(segment, Comp.Plain)
        )
        is_mention = any(
            isinstance(segment, Comp.At) and str(segment.qq) == str(self_id)
            for segment in messages
        )
        has_supported_content = any(
            (isinstance(segment, Comp.Plain) and bool(segment.text.strip()))
            or (
                isinstance(segment, Comp.Reply)
                and bool((segment.message_str or "").strip())
            )
            or (isinstance(segment, Comp.Image) and self._enable_vision)
            or (isinstance(segment, Comp.Record) and self._enable_hearing)
            for segment in messages
        )
        is_wake = bool(event.is_wake) or any(
            word in text.casefold() for word in self._wake_words
        )
        return RoutingFacts(
            platform_instance_id=event.get_platform_id(),
            sender_id=str(sender_id),
            is_platform_message=_is_platform_message(event),
            is_private=message_type == "FriendMessage",
            is_group=message_type == "GroupMessage",
            is_mention=is_mention,
            is_wake=is_wake,
            is_self_message=bool(sender_id and self_id and sender_id == self_id),
            is_stopped=event.is_stopped(),
            has_supported_content=has_supported_content,
            text=text,
        )

    async def convert(
        self, event: AstrMessageEvent
    ) -> tuple[LumiPerceptionEvent, list[str]]:
        platform = event.get_platform_name()
        platform_instance_id = event.get_platform_id()
        sender_id = event.get_sender_id()
        group_id = event.get_group_id() or None
        unified_origin = event.unified_msg_origin
        message_id = str(getattr(event.message_obj, "message_id", "") or "")
        if not message_id:
            message_id = f"timestamp-{getattr(event.message_obj, 'timestamp', 0)}"
        person_key = await self._identity_mapper.resolve_person(
            platform_instance_id, sender_id
        )
        conversation_key = await self._identity_mapper.resolve_conversation(
            unified_origin
        )
        self_id = event.get_self_id()
        segments = []
        temporary_paths: list[str] = []
        input_has_audio = False
        native_failure_reasons: list[str] = []
        for index, component in enumerate(event.get_messages()):
            if isinstance(component, Comp.Plain):
                if component.text:
                    segments.append(
                        LumiTextSegment(
                            text=component.text,
                            metadata={"chain_index": index},
                        )
                    )
                continue
            if isinstance(component, Comp.At):
                if str(component.qq) != str(self_id):
                    segments.append(
                        LumiTextSegment(
                            text=f"@{component.name or component.qq}",
                            metadata={
                                "chain_index": index,
                                "kind": "mention",
                                "target_id": str(component.qq),
                            },
                        )
                    )
                continue
            if isinstance(component, Comp.Reply):
                quoted = (component.message_str or "").strip()
                if quoted:
                    segments.append(
                        LumiTextSegment(
                            text=quoted,
                            metadata={
                                "chain_index": index,
                                "kind": "quote",
                                "quoted_message_id": str(component.id),
                                "quoted_sender_id": str(component.sender_id or ""),
                                "quoted_sender_name": component.sender_nickname or "",
                            },
                        )
                    )
                continue
            if isinstance(component, Comp.Image) and self._enable_vision:
                segment, temporary = await self._image_resolver.resolve(
                    _media_reference(component),
                    {"chain_index": index, "astrbot_component": "Image"},
                )
                segments.append(segment)
                if temporary:
                    temporary_paths.append(temporary)
                continue
            if isinstance(component, Comp.Record) and self._enable_hearing:
                input_has_audio = True
                if self._prefer_qq_native_transcription:
                    transcript, failure_reason = await _qq_native_transcript(event)
                    if transcript:
                        segments.append(
                            LumiTextSegment(
                                text=transcript,
                                metadata={
                                    "chain_index": index,
                                    "kind": "auditory_transcript",
                                    "transcription_provider": "qq_native",
                                    "astrbot_component": "Record",
                                },
                            )
                        )
                        continue
                    if failure_reason:
                        native_failure_reasons.append(failure_reason)
                reference = await _audio_media_reference(event, component, index)
                segment, temporary = await self._audio_resolver.resolve(
                    reference,
                    {"chain_index": index, "astrbot_component": "Record"},
                )
                segments.append(segment)
                if temporary:
                    temporary_paths.append(temporary)

        facts = self.routing_facts(event)
        timestamp = int(getattr(event.message_obj, "timestamp", 0) or 0)
        return (
            LumiPerceptionEvent(
                event_id=f"{platform_instance_id}:{message_id}",
                platform=platform,
                platform_instance_id=platform_instance_id,
                unified_session_id=unified_origin,
                conversation_id=conversation_key,
                sender_id=sender_id,
                sender_name=event.get_sender_name() or sender_id,
                group_id=group_id,
                message_id=message_id,
                timestamp=timestamp,
                is_private=facts.is_private,
                is_group=facts.is_group,
                is_mention=facts.is_mention,
                segments=segments,
                metadata={
                    "person_key": person_key,
                    "message_type": str(event.get_message_type().value),
                    "input_has_audio": input_has_audio,
                    **(
                        {
                            "qq_native_transcription_error": "; ".join(
                                dict.fromkeys(native_failure_reasons)
                            )[:300]
                        }
                        if native_failure_reasons
                        else {}
                    ),
                },
            ),
            temporary_paths,
        )


def plugin_temp_directory(plugin_name: str) -> Path:
    from astrbot.core.utils.astrbot_path import get_astrbot_data_path

    return (
        Path(get_astrbot_data_path()) / "plugin_data" / plugin_name / "temporary_media"
    )


def _is_platform_message(event: AstrMessageEvent) -> bool:
    """Rejects protocol notifications that AstrBot exposes as chat-shaped events."""
    raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
    getter = getattr(raw, "get", None)
    if not callable(getter):
        return True

    post_type = getter("post_type")
    if not isinstance(post_type, str) or not post_type.strip():
        return True

    # NOTICE:
    # SnowLuma reports private typing/recording state as
    # notice/notify/input_status. AstrBot 4.26.7's aiocqhttp adapter wraps any
    # notice without a group_id as FriendMessage, so EventMessageType cannot
    # distinguish it from a real private message. The original OneBot envelope
    # remains available through message_obj.raw_message and is authoritative.
    # Sources:
    # SnowLuma packages/onebot/src/event-converter/to-notice.ts
    # AstrBot astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py
    return post_type == "message"


async def _qq_native_transcript(
    event: AstrMessageEvent,
) -> tuple[str | None, str | None]:
    if event.get_platform_name() != "aiocqhttp":
        return None, "platform does not expose the OneBot QQ transcription action"
    raw_message_id = getattr(getattr(event, "message_obj", None), "message_id", None)
    message_id = (
        str(raw_message_id).strip()
        if isinstance(raw_message_id, (int, str)) and not isinstance(raw_message_id, bool)
        else ""
    )
    call_action = getattr(getattr(event, "bot", None), "call_action", None)
    if not message_id or not callable(call_action):
        return None, "message id or OneBot action client is unavailable"
    try:
        result = await call_action("fetch_ptt_text", message_id=message_id)
    except Exception as error:
        # SnowLuma and NapCat expose the same action but can fail for different
        # reasons. Preserve a bounded diagnostic while keeping media URLs,
        # message content, and authentication data out of logs.
        return None, _safe_action_error(error)
    if not isinstance(result, dict):
        return None, "OneBot action returned a non-object response"
    payload = result.get("data") if isinstance(result.get("data"), dict) else result
    transcript = _optional_string(payload.get("text"))
    if not transcript:
        return None, "OneBot action returned no transcription text"
    return transcript, None


def _safe_action_error(error: Exception) -> str:
    message = " ".join(str(error).split()).strip()
    if not message:
        return type(error).__name__
    return f"{type(error).__name__}: {message}"[:300]


def _media_reference(component: Any) -> MediaReference:
    duration = getattr(component, "duration", None)
    duration_ms = None
    if isinstance(duration, (int, float)) and duration > 0:
        duration_ms = int(duration * 1000)
    return MediaReference(
        file=_optional_string(getattr(component, "file", None)),
        url=_optional_string(getattr(component, "url", None)),
        path=_optional_string(getattr(component, "path", None)),
        mime_type=_optional_string(
            getattr(component, "mime_type", None)
            or getattr(component, "mimetype", None)
        ),
        duration_ms=duration_ms,
    )


async def _audio_media_reference(
    event: AstrMessageEvent, component: Any, chain_index: int
) -> MediaReference:
    reference = _media_reference(component)
    if _reference_is_resolvable(reference):
        return reference

    raw_file = _raw_record_file(event, chain_index) or reference.file
    bot = getattr(event, "bot", None)
    call_action = getattr(bot, "call_action", None)
    if not raw_file or not callable(call_action):
        return reference

    # OneBot implementations may omit the resolved URL/path from AstrBot's
    # Record component while retaining the platform file token in raw_message.
    # get_record resolves that token without invoking AstrBot's ASR pipeline.
    result = await call_action("get_record", file=raw_file, out_format="wav")
    if not isinstance(result, dict):
        return reference
    payload = result.get("data") if isinstance(result.get("data"), dict) else result
    return MediaReference(
        file=_optional_string(payload.get("file")),
        url=_optional_string(payload.get("url")),
        path=_optional_string(payload.get("path")),
        # Some OneBot implementations ignore out_format and return the original
        # SILK/AMR bytes. Let the media resolver inspect the bytes instead of
        # falsely declaring every get_record response as WAV.
        mime_type=None,
        duration_ms=reference.duration_ms,
    )


def _reference_is_resolvable(reference: MediaReference) -> bool:
    for value in (reference.path, reference.url, reference.file):
        if not value:
            continue
        if value.startswith(("http://", "https://", "file://", "base64://", "data:")):
            return True
        parsed = urlparse(value)
        if not parsed.scheme:
            try:
                if Path(value).is_file():
                    return True
            except OSError:
                pass
    return False


def _raw_record_file(event: AstrMessageEvent, chain_index: int) -> str | None:
    raw = getattr(getattr(event, "message_obj", None), "raw_message", None)
    getter = getattr(raw, "get", None)
    if not callable(getter):
        return None
    message = getter("message")
    if not isinstance(message, list):
        return None

    candidates = [
        segment
        for segment in message
        if isinstance(segment, dict) and segment.get("type") == "record"
    ]
    direct = message[chain_index] if chain_index < len(message) else None
    if isinstance(direct, dict) and direct.get("type") == "record":
        candidates.insert(0, direct)
    for segment in candidates:
        data = segment.get("data")
        if isinstance(data, dict):
            value = _optional_string(data.get("file"))
            if value:
                return value
    return None


def _optional_string(value: object) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None
