from __future__ import annotations

import asyncio
import base64
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import patch

import httpx

from lumi_bridge.client import HttpLumiRuntimeClient
from lumi_bridge.exceptions import (
    AudioConversionError,
    HearingUnavailableError,
    LumiAuthenticationError,
    LumiIdentityUnboundError,
    LumiProtocolError,
    LumiUnavailableError,
    MediaDownloadError,
    MediaTooLargeError,
    UnsupportedMediaError,
)
from lumi_bridge.media import (
    AudioResolver,
    ImageResolver,
    MediaReference,
    MediaResolver,
    cleanup_temporary_files,
    redact_url,
)
from lumi_bridge.models import (
    LumiGroupObservationEvent,
    LumiPerceptionEvent,
    LumiTextSegment,
)


PNG = b"\x89PNG\r\n\x1a\n" + b"content"
WAV = b"RIFF" + b"0000" + b"WAVE" + b"audio"


def perception() -> LumiPerceptionEvent:
    return LumiPerceptionEvent(
        event_id="qq:message",
        platform="aiocqhttp",
        platform_instance_id="qq",
        unified_session_id="qq:friend:1",
        conversation_id="qq:friend:1",
        sender_id="1",
        sender_name="Doggy",
        group_id=None,
        message_id="message",
        timestamp=1,
        is_private=True,
        is_group=False,
        is_mention=False,
        segments=[LumiTextSegment(text="hello")],
    )


def group_observation() -> LumiGroupObservationEvent:
    return LumiGroupObservationEvent(
        event_id="qq:group-message",
        message_id="group-message",
        source_id="default:100",
        group_id="100",
        platform="aiocqhttp",
        platform_instance_id="default",
        sender_id="300",
        sender_name="Friend",
        timestamp=1,
        segments=[LumiTextSegment(text="hello")],
    )


class MediaResolverTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_image_is_preserved_without_temporary_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "image.png"
            image_path.write_bytes(PNG)
            async with httpx.AsyncClient() as client:
                resolver = ImageResolver(
                    MediaResolver(client, Path(directory) / "temp", 1),
                    1024,
                )
                segment, temporary = await resolver.resolve(
                    MediaReference(path=str(image_path))
                )
            self.assertEqual(segment.mime_type, "image/png")
            self.assertEqual(segment.size_bytes, len(PNG))
            self.assertIsNone(temporary)

    async def test_multiple_downloads_keep_call_order_and_cleanup(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            body = PNG if request.url.path.endswith("1") else WAV
            media_type = "image/png" if body is PNG else "audio/wav"
            return httpx.Response(
                200, content=body, headers={"content-type": media_type}
            )

        with tempfile.TemporaryDirectory() as directory:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            ) as client:
                media = MediaResolver(client, Path(directory), 1)
                image, image_temp = await ImageResolver(media, 1024).resolve(
                    MediaReference(url="https://media.example/image/1?token=secret")
                )
                audio, audio_temp = await AudioResolver(
                    media, 1024, 5000, Path(directory), "ffmpeg", 1
                ).resolve(
                    MediaReference(
                        url="https://media.example/audio/2?token=secret",
                        duration_ms=1000,
                    )
                )
            self.assertEqual([image.type, audio.type], ["image", "audio"])
            self.assertTrue(Path(image_temp or "").exists())
            self.assertTrue(Path(audio_temp or "").exists())
            cleanup_temporary_files([image_temp or "", audio_temp or ""])
            self.assertFalse(Path(image_temp or "").exists())
            self.assertFalse(Path(audio_temp or "").exists())

    async def test_download_failure_redacts_auth_query(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(403)

        with tempfile.TemporaryDirectory() as directory:
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            ) as client:
                resolver = MediaResolver(client, Path(directory), 1)
                with self.assertRaises(MediaDownloadError) as raised:
                    await resolver.resolve(
                        MediaReference(
                            url="https://media.example/file?access_token=private"
                        ),
                        kind="image",
                        maximum_bytes=1024,
                    )
            self.assertNotIn("private", str(raised.exception))
            self.assertEqual(
                redact_url("https://media.example/file?access_token=private"),
                "https://media.example/file",
            )

    async def test_media_size_duration_and_type_limits_are_enforced(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            large = Path(directory) / "large.png"
            large.write_bytes(PNG * 20)
            unknown = Path(directory) / "unknown.bin"
            unknown.write_bytes(b"not media")
            async with httpx.AsyncClient() as client:
                media = MediaResolver(client, Path(directory) / "temp", 1)
                with self.assertRaises(MediaTooLargeError):
                    await ImageResolver(media, 10).resolve(
                        MediaReference(path=str(large))
                    )
                with self.assertRaises(MediaTooLargeError):
                    await AudioResolver(
                        media, 1024, 100, Path(directory), "ffmpeg", 1
                    ).resolve(MediaReference(path=str(large), duration_ms=101))
                with self.assertRaises(UnsupportedMediaError):
                    await ImageResolver(media, 1024).resolve(
                        MediaReference(path=str(unknown))
                    )

    async def test_amr_conversion_reports_missing_ffmpeg_clearly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio_path = Path(directory) / "voice.amr"
            audio_path.write_bytes(b"#!AMR\n" + b"audio")
            async with httpx.AsyncClient() as client:
                media = MediaResolver(client, Path(directory) / "temp", 1)
                resolver = AudioResolver(
                    media,
                    1024,
                    5000,
                    Path(directory) / "temp",
                    "definitely-missing-lumi-ffmpeg",
                    1,
                )
                with self.assertRaises(AudioConversionError) as raised:
                    await resolver.resolve(MediaReference(path=str(audio_path)))
            self.assertIn("FFmpeg is required", str(raised.exception))

    async def test_detected_audio_bytes_override_incorrect_qq_mime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            audio_path = Path(directory) / "voice.bin"
            audio_path.write_bytes(WAV)
            async with httpx.AsyncClient() as client:
                resolver = MediaResolver(client, Path(directory) / "temp", 1)
                resolved = await resolver.resolve(
                    MediaReference(
                        path=str(audio_path),
                        mime_type="audio/mpeg",
                    ),
                    kind="audio",
                    maximum_bytes=1024,
                )

            self.assertEqual(resolved.mime_type, "audio/wav")

    async def test_qq_silk_uses_astrbot_pysilk_without_ffmpeg(self) -> None:
        fake_pysilk = ModuleType("pysilk")

        def decode(source, destination, sample_rate: int) -> None:
            self.assertEqual(sample_rate, 24000)
            self.assertTrue(source.read().startswith(b"#!SILK_V3"))
            destination.write(b"\x00\x00" * 240)

        fake_pysilk.decode = decode  # type: ignore[attr-defined]
        silk = b"\x02#!SILK_V3" + b"qq-audio"
        with tempfile.TemporaryDirectory() as directory:
            async with httpx.AsyncClient() as client:
                media = MediaResolver(client, Path(directory) / "temp", 1)
                resolver = AudioResolver(
                    media,
                    4096,
                    5000,
                    Path(directory) / "temp",
                    "definitely-missing-lumi-ffmpeg",
                    1,
                )
                with patch.dict(sys.modules, {"pysilk": fake_pysilk}):
                    segment, temporary = await resolver.resolve(
                        MediaReference(
                            file="base64://"
                            + base64.b64encode(silk).decode("ascii")
                        )
                    )

            self.assertEqual(segment.mime_type, "audio/wav")
            self.assertTrue(
                base64.b64decode(segment.data_base64 or "").startswith(b"RIFF")
            )
            self.assertTrue(Path(temporary or "").is_file())
            cleanup_temporary_files([temporary or ""])


class HttpLumiClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_tool_progress_is_polled_in_order_while_reply_is_pending(
        self,
    ) -> None:
        progress_requests = 0
        received: list[tuple[int, str]] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal progress_requests
            if request.url.path.endswith("/progress"):
                progress_requests += 1
                if progress_requests == 1:
                    return httpx.Response(
                        200,
                        json={
                            "events": [
                                {
                                    "sequence": 1,
                                    "tool_name": "query_memory",
                                    "status": "started",
                                    "message": "我先确认一下记忆里的日期。",
                                    "timestamp": 1,
                                },
                                {
                                    "sequence": 2,
                                    "tool_name": "browser_navigate",
                                    "status": "started",
                                    "message": "第5个账号已处理，继续下一个。",
                                    "timestamp": 2,
                                },
                                {
                                    "sequence": 3,
                                    "tool_name": "browser_navigate",
                                    "status": "started",
                                    "message": "第5个账号已处理，继续下一个。",
                                    "timestamp": 3,
                                },
                                {
                                    "sequence": 4,
                                    "tool_name": "builtin_mcpCallTool",
                                    "status": "failed",
                                    "message": "fixed failure message",
                                    "timestamp": 4,
                                },
                            ],
                            "complete": False,
                        },
                    )
                return httpx.Response(200, json={"events": [], "complete": True})
            await asyncio.sleep(0.05)
            return httpx.Response(
                200,
                json={
                    "response_id": "reply-1",
                    "text": "查到了",
                    "segments": [{"type": "text", "text": "查到了"}],
                    "metadata": {},
                },
            )

        async def collect(progress) -> None:
            received.append((progress.sequence, progress.message))

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "secret-token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            response = await client.perceive_and_respond(perception(), collect)
        finally:
            await client.close()

        self.assertEqual(response.text, "查到了")
        self.assertEqual(
            received,
            [
                (1, "我先确认一下记忆里的日期。"),
                (2, "第5个账号已处理，继续下一个。"),
            ],
        )

    async def test_speech_request_returns_complete_audio_bytes(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.path, "/api/lumi/integrations/astrbot/speech")
            self.assertEqual(json.loads(request.content), {"text": "第一条回复"})
            return httpx.Response(
                200,
                json={
                    "data_base64": base64.b64encode(WAV).decode("ascii"),
                    "mime_type": "audio/wav",
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "secret-token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            speech = await client.synthesize_speech("第一条回复")
        finally:
            await client.close()

        self.assertEqual(speech.data, WAV)
        self.assertEqual(speech.mime_type, "audio/wav")

    async def test_successful_request_uses_token_and_returns_lumi_response(
        self,
    ) -> None:
        observed: dict[str, object] = {}

        async def handler(request: httpx.Request) -> httpx.Response:
            observed["authorization"] = request.headers.get("authorization")
            observed["payload"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={
                    "response_id": "reply-1",
                    "text": "Lumi reply",
                    "segments": [{"type": "text", "text": "Lumi reply"}],
                    "metadata": {},
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6130",
            "secret-token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            response = await client.perceive_and_respond(perception())
        finally:
            await client.close()
        self.assertEqual(response.text, "Lumi reply")
        self.assertEqual(observed["authorization"], "Bearer secret-token")
        self.assertEqual(observed["payload"]["segments"][0]["type"], "text")  # type: ignore[index]

    async def test_learning_policy_and_observation_use_lumi_owned_allowlist(
        self,
    ) -> None:
        observed_paths: list[str] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            observed_paths.append(request.url.path)
            if request.url.path.endswith("/learning-policy"):
                return httpx.Response(
                    200,
                    json={
                        "private_reply_enabled": True,
                        "group_observation_enabled": True,
                        "groups": [
                            {
                                "source_id": "default:100",
                                "platform_instance_id": "default",
                                "group_id": "100",
                                "priority": "high",
                            }
                        ],
                    },
                )
            return httpx.Response(
                202, json={"accepted": True, "reply_suppressed": True}
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "secret-token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            policy = await client.learning_policy()
            await client.observe_group(group_observation())
        finally:
            await client.close()
        self.assertTrue(policy.private_reply_enabled)
        self.assertTrue(policy.group_observation_enabled)
        self.assertIsNotNone(policy.source_for("default", "100"))
        self.assertEqual(
            observed_paths,
            [
                "/api/lumi/integrations/astrbot/learning-policy",
                "/api/lumi/integrations/astrbot/observe",
            ],
        )

    async def test_authentication_failure_is_classified(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": "no"})

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6130",
            "bad-token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            with self.assertRaises(LumiAuthenticationError):
                await client.perceive_and_respond(perception())
        finally:
            await client.close()

    async def test_lumi_owned_identity_rejection_is_classified(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403,
                json={
                    "code": "identity_unbound",
                    "error": "AstrBot identity is not bound",
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            with self.assertRaises(LumiIdentityUnboundError):
                await client.perceive_and_respond(perception())
        finally:
            await client.close()

    async def test_runtime_readiness_error_preserves_actionable_detail(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                503,
                json={
                    "code": "runtime_not_ready",
                    "error": "Select and save an active provider and model.",
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            with self.assertRaisesRegex(LumiUnavailableError, "active provider"):
                await client.perceive_and_respond(perception())
        finally:
            await client.close()

    async def test_hearing_error_preserves_desktop_provider_detail(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                503,
                json={
                    "code": "hearing_unavailable",
                    "error": "Transcription provider rejected model whisper-1",
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            with self.assertRaisesRegex(
                HearingUnavailableError, "rejected model whisper-1"
            ):
                await client.perceive_and_respond(perception())
        finally:
            await client.close()

    async def test_protocol_error_preserves_desktop_detail(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                400,
                json={
                    "code": "invalid_event",
                    "error": "Audio provider rejected the selected model",
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            with self.assertRaisesRegex(
                LumiProtocolError, "Audio provider rejected the selected model"
            ):
                await client.perceive_and_respond(perception())
        finally:
            await client.close()

    async def test_server_error_preserves_desktop_generation_detail(self) -> None:
        async def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                500,
                json={
                    "code": "generation_failed",
                    "error": "Selected consciousness provider rejected the request",
                },
            )

        client = HttpLumiRuntimeClient(
            "http://127.0.0.1:6132",
            "token",
            1,
            1,
            httpx.MockTransport(handler),
        )
        try:
            with self.assertRaisesRegex(
                LumiUnavailableError,
                "Selected consciousness provider rejected the request",
            ):
                await client.perceive_and_respond(perception())
        finally:
            await client.close()
