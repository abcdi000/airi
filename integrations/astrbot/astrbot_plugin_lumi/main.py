from __future__ import annotations

import asyncio
import os
import random
import tempfile
from pathlib import Path

from astrbot import logger
from astrbot.api import AstrBotConfig
from astrbot.api import message_components as Comp
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star
from astrbot.api.web import json_response

from .lumi_bridge.astrbot_adapter import plugin_temp_directory
from .lumi_bridge.client import LumiRuntimeClient
from .lumi_bridge.config import LumiPluginConfig
from .lumi_bridge.exceptions import (
    DuplicateEventError,
    LumiAuthenticationError,
    LumiBridgeError,
    LumiIdentityUnboundError,
)
from .lumi_bridge.media import cleanup_temporary_files
from .lumi_bridge.models import LumiResponse
from .lumi_bridge.routing import decide_routing
from .lumi_bridge.service import LumiBridgeService


class Main(Star):
    """Makes Lumi, rather than AstrBot's default model, the reply subject."""

    def __init__(self, context: Context, config: AstrBotConfig) -> None:
        super().__init__(context, config)
        self._astrbot_config = config
        self._service = self._build_service()
        context.register_web_api(
            "/astrbot_plugin_lumi/connection-test",
            self.connection_test,
            ["GET"],
            "Test the configured Lumi runtime connection",
        )

    @filter.event_message_type(filter.EventMessageType.PRIVATE_MESSAGE, priority=-100)
    async def bridge_message(self, event: AstrMessageEvent) -> None:
        event_id = _safe_event_id(event)
        facts = self._service.adapter.routing_facts(event)
        decision = decide_routing(self._service.config, facts)
        if not decision.handle:
            if decision.suppress_default:
                event.should_call_llm(True)
                event.stop_event()
            return

        # NOTICE:
        # AstrBot 4.26.7's source uses call_llm=True as the suppression flag even
        # though should_call_llm() reads like an affirmative opt-in. ProcessStage
        # invokes the default agent only when `not event.call_llm`.
        # Remove this comment when AstrBot exposes an unambiguous public method.
        event.should_call_llm(True)
        temporary_paths: list[str] = []
        succeeded = False
        try:
            perception, temporary_paths = await self._service.adapter.convert(event)
            if (
                perception.platform == "aiocqhttp"
                and perception.metadata.get("input_has_audio")
            ):
                uses_native_transcription = any(
                    segment.type == "text"
                    and segment.metadata.get("transcription_provider") == "qq_native"
                    for segment in perception.segments
                )
                if uses_native_transcription:
                    logger.info(
                        "Lumi input uses QQ native transcription event_id=%s",
                        event_id,
                    )
                elif self._service.config.prefer_qq_native_transcription:
                    native_reason = perception.metadata.get(
                        "qq_native_transcription_error"
                    )
                    logger.warning(
                        "QQ native transcription was unavailable; "
                        "falling back to Lumi hearing event_id=%s reason=%s",
                        event_id,
                        native_reason or "unknown",
                    )

            async def invoke_lumi() -> LumiResponse:
                return await self._service.client.perceive_and_respond(perception)

            response = await self._service.sessions.run(
                perception.conversation_id,
                perception.event_id,
                invoke_lumi,
            )
            use_voice = self._service.config.should_reply_with_voice(
                input_has_audio=bool(perception.metadata.get("input_has_audio"))
                or any(segment.type == "audio" for segment in perception.segments),
                random_value=random.random(),
            )
            messages, output_paths = await _response_messages(
                response,
                use_voice=use_voice,
                client=self._service.speech_client,
                temp_directory=self._service.temp_directory,
            )
            temporary_paths.extend(output_paths)
            if messages:
                for chain in messages:
                    await _send_without_escaping(
                        event, event.chain_result(chain), event_id
                    )
            else:
                logger.warning("Lumi returned an empty response event_id=%s", event_id)
            succeeded = True
            event.stop_event()
        except DuplicateEventError:
            logger.info("Ignored duplicate Lumi event event_id=%s", event_id)
            event.stop_event()
        except LumiIdentityUnboundError:
            logger.info(
                "Ignored an AstrBot account not authorized by Lumi event_id=%s",
                event_id,
            )
            event.stop_event()
        except LumiBridgeError as error:
            logger.warning(
                "Lumi bridge request failed event_id=%s type=%s reason=%s",
                event_id,
                type(error).__name__,
                str(error),
            )
            await self._handle_failure(event, error, event_id)
        except Exception:
            logger.exception("Unexpected Lumi bridge failure event_id=%s", event_id)
            await self._handle_failure(event, None, event_id)
        finally:
            retention = self._service.config.temp_file_retention
            if retention == "delete" or (retention == "keep_on_error" and succeeded):
                cleanup_temporary_files(temporary_paths)

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("lumi_status", priority=100)
    async def lumi_status(self, event: AstrMessageEvent):
        config = self._service.config
        yield event.plain_result(
            "\n".join(
                [
                    f"Lumi bridge: {'enabled' if config.enabled else 'disabled'}",
                    f"Target: {config.lumi_target}",
                    f"Endpoint: {config.lumi_endpoint}",
                    f"Token: {'configured' if config.lumi_api_token else 'missing'}",
                    f"Trigger: {config.trigger_mode}",
                    "Identity authorization: managed by Lumi",
                    "Group messages: disabled",
                    f"Vision: {'enabled' if config.enable_vision else 'disabled'}",
                    f"Hearing: {'enabled' if config.enable_hearing else 'disabled'}",
                ]
            )
        )

    async def connection_test(self):
        """Returns a token-free runtime diagnostic for the AstrBot plugin Page."""
        config = self._service.config
        health = await self._service.client.health_check()
        return json_response(
            {
                "available": health.available,
                "target": config.lumi_target,
                "endpoint": config.lumi_endpoint,
                "token_configured": bool(config.lumi_api_token),
                "version": health.version,
                "vision": health.vision,
                "hearing": health.hearing,
                "detail": health.detail,
            }
        )

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("lumi_health", priority=100)
    async def lumi_health(self, event: AstrMessageEvent):
        try:
            health = await self._service.client.health_check()
        except LumiBridgeError as error:
            yield event.plain_result(
                f"Lumi runtime: unavailable\nReason: {_failure_message(error)}"
            )
            return
        yield event.plain_result(
            "\n".join(
                [
                    f"Lumi runtime: {'online' if health.available else 'offline'}",
                    f"Version: {health.version or 'unknown'}",
                    f"Vision: {'ready' if health.vision else 'unavailable'}",
                    f"Hearing: {'ready' if health.hearing else 'unavailable'}",
                ]
            )
        )

    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("lumi_reload", priority=100)
    async def lumi_reload(self, event: AstrMessageEvent):
        previous = self._service
        self._service = self._build_service()
        await previous.close()
        yield event.plain_result("Lumi bridge configuration reloaded.")

    async def terminate(self) -> None:
        await self._service.close()

    def _build_service(self) -> LumiBridgeService:
        config = LumiPluginConfig.from_mapping(dict(self._astrbot_config))
        return LumiBridgeService(config, plugin_temp_directory(self.name))

    async def _handle_failure(
        self,
        event: AstrMessageEvent,
        error: LumiBridgeError | None,
        event_id: str,
    ) -> None:
        policy = self._service.config.failure_policy
        if (
            policy == "allow_default_llm_fallback"
            or self._service.config.allow_default_llm_fallback
        ):
            event.should_call_llm(False)
            return
        if policy == "friendly_error":
            await _send_without_escaping(
                event,
                event.plain_result(_failure_message(error)),
                event_id,
            )
        event.stop_event()


async def _response_messages(
    response: LumiResponse,
    *,
    use_voice: bool,
    client: LumiRuntimeClient,
    temp_directory: Path,
) -> tuple[list[list[Comp.BaseMessageComponent]], list[str]]:
    messages: list[list[Comp.BaseMessageComponent]] = []
    temporary_paths: list[str] = []

    async def append_text(text: str) -> None:
        for part in _split_lumi_reply(text):
            if not use_voice:
                messages.append([Comp.Plain(part)])
                continue
            try:
                speech = await client.synthesize_speech(part)
                path = await _write_speech_file(
                    speech.data, speech.mime_type, temp_directory
                )
            except (LumiBridgeError, OSError) as error:
                logger.warning(
                    "Lumi speech synthesis failed; sending text instead: %s",
                    str(error),
                )
                messages.append([Comp.Plain(part)])
                continue
            temporary_paths.append(str(path))
            messages.append([Comp.Record.fromFileSystem(str(path))])

    if response.segments:
        for segment in response.segments:
            if segment.type == "text" and segment.text:
                await append_text(segment.text)
            elif segment.type == "image":
                if segment.local_path:
                    messages.append([Comp.Image.fromFileSystem(segment.local_path)])
                elif segment.url:
                    messages.append([Comp.Image.fromURL(segment.url)])
            elif segment.type == "audio":
                if segment.local_path:
                    messages.append([Comp.Record.fromFileSystem(segment.local_path)])
                elif segment.url:
                    messages.append([Comp.Record.fromURL(segment.url)])
    elif response.text:
        await append_text(response.text)
    return messages, temporary_paths


async def _write_speech_file(
    data: bytes, mime_type: str, temp_directory: Path
) -> Path:
    suffixes = {
        "audio/aac": ".aac",
        "audio/flac": ".flac",
        "audio/mp4": ".m4a",
        "audio/mpeg": ".mp3",
        "audio/ogg": ".ogg",
        "audio/opus": ".opus",
        "audio/wav": ".wav",
        "audio/x-wav": ".wav",
    }
    suffix = suffixes.get(mime_type.split(";", 1)[0].lower(), ".mp3")
    temp_directory.mkdir(parents=True, exist_ok=True)
    handle, name = tempfile.mkstemp(
        prefix="lumi-reply-", suffix=suffix, dir=temp_directory
    )
    os.close(handle)
    path = Path(name)
    try:
        await asyncio.to_thread(path.write_bytes, data)
    except OSError:
        path.unlink(missing_ok=True)
        raise
    return path


def _split_lumi_reply(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").strip()
    if not normalized:
        return []
    if "```" in normalized:
        return [normalized]
    for separator in (
        "<|lumi_next_reply|>",
        "<<<LUMI_NEXT_REPLY>>>",
        "[LUMI_NEXT_REPLY]",
        "<!-- lumi_next_reply -->",
    ):
        normalized = normalized.replace(separator, "\n\n")
    parts = [part.strip() for part in normalized.split("\n\n") if part.strip()]
    if len(parts) > 1:
        return parts
    lines = [line.strip() for line in normalized.splitlines() if line.strip()]
    if (
        1 < len(lines) <= 8
        and all(len(line) <= 160 for line in lines)
        and all(
            not line.startswith(("-", "*", "+", "#", ">", "|"))
            and not (line[0].isdigit() and len(line) > 1 and line[1] in ".)")
            for line in lines
        )
    ):
        return lines
    return [normalized]


def _safe_event_id(event: AstrMessageEvent) -> str:
    message_id = str(getattr(event.message_obj, "message_id", "") or "unknown")
    return f"{event.get_platform_id()}:{message_id}"


async def _send_without_escaping(
    event: AstrMessageEvent,
    result: object,
    event_id: str,
) -> bool:
    """Keeps platform delivery failures outside the Lumi handler boundary."""
    try:
        await event.send(result)
        return True
    except Exception:
        # The platform may reject delivery after Lumi has already committed the
        # event. Re-raising here makes AstrBot report a plugin crash and risks a
        # second reply attempt, so delivery remains a terminal platform error.
        logger.exception("AstrBot platform delivery failed event_id=%s", event_id)
        return False


def _failure_message(error: LumiBridgeError | None) -> str:
    if isinstance(error, LumiAuthenticationError):
        if "not configured" in str(error).lower():
            return (
                "Lumi 连接尚未配置：请在 AstrBot 插件设置中填写 "
                "桌面 Lumi 或 Lumi Server Manager 生成的集成令牌。"
            )
        return "Lumi 拒绝了连接，请检查目标、集成令牌和平台账号绑定。"
    return "Lumi 现在暂时无法回应，请稍后再和我说一次。"
