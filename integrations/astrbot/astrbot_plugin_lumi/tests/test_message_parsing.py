from __future__ import annotations

import tempfile
import unittest
import sys
from pathlib import Path
from types import SimpleNamespace
from types import ModuleType

import httpx


class Plain:
    def __init__(self, text: str) -> None:
        self.text = text


class At:
    def __init__(self, qq: str, name: str | None = None) -> None:
        self.qq = qq
        self.name = name


class Reply:
    def __init__(
        self,
        id: str,
        message_str: str,
        sender_id: str | None = None,
        sender_nickname: str | None = None,
    ) -> None:
        self.id = id
        self.message_str = message_str
        self.sender_id = sender_id
        self.sender_nickname = sender_nickname


class Image:
    def __init__(
        self,
        file: str | None = None,
        path: str | None = None,
        url: str | None = None,
    ) -> None:
        self.file = file
        self.path = path
        self.url = url

    @classmethod
    def fromFileSystem(cls, path: str):
        return cls(file=Path(path).resolve().as_uri(), path=str(Path(path).resolve()))


class Record:
    def __init__(
        self,
        file: str | None = None,
        path: str | None = None,
        url: str | None = None,
    ) -> None:
        self.file = file
        self.path = path
        self.url = url

    @classmethod
    def fromFileSystem(cls, path: str):
        return cls(file=Path(path).resolve().as_uri(), path=str(Path(path).resolve()))


components = ModuleType("astrbot.api.message_components")
components.Plain = Plain
components.At = At
components.Reply = Reply
components.Image = Image
components.Record = Record
api = ModuleType("astrbot.api")
api.message_components = components
event_api = ModuleType("astrbot.api.event")
event_api.AstrMessageEvent = object
astrbot = ModuleType("astrbot")
sys.modules["astrbot"] = astrbot
sys.modules["astrbot.api"] = api
sys.modules["astrbot.api.message_components"] = components
sys.modules["astrbot.api.event"] = event_api

# NOTICE:
# These imports must follow the public AstrBot component fixture so the bridge
# can be tested without installing every platform SDK in AstrBot's dependency set.
# Remove this fixture when AstrBot publishes a lightweight plugin test package.
from astrbot.api import message_components as Comp  # noqa: E402

from lumi_bridge.astrbot_adapter import AstrBotEventAdapter  # noqa: E402
from lumi_bridge.identity import PlatformIdentityMapper  # noqa: E402
from lumi_bridge.media import AudioResolver, ImageResolver, MediaResolver  # noqa: E402


PNG = b"\x89PNG\r\n\x1a\n" + b"content"
WAV = b"RIFF" + b"0000" + b"WAVE" + b"audio"


class FakeEvent:
    def __init__(
        self,
        messages: list[object],
        group_id: str = "",
        message_type: str | None = None,
    ) -> None:
        self._messages = messages
        self._group_id = group_id
        self._message_type = message_type or (
            "GroupMessage" if group_id else "FriendMessage"
        )
        self.is_wake = False
        self.unified_msg_origin = (
            f"aiocqhttp:group:{group_id}" if group_id else "aiocqhttp:friend:10001"
        )
        self.message_obj = SimpleNamespace(
            message_id="message-1",
            timestamp=1_700_000_000,
            raw_message={},
        )
        self.bot = None

    def get_sender_id(self) -> str:
        return "10001"

    def get_self_id(self) -> str:
        return "20002"

    def get_group_id(self) -> str:
        return self._group_id

    def get_platform_name(self) -> str:
        return "aiocqhttp"

    def get_platform_id(self) -> str:
        return "qq-bot-1"

    def get_sender_name(self) -> str:
        return "Doggy"

    def get_messages(self) -> list[object]:
        return self._messages

    def get_message_type(self):
        return SimpleNamespace(value=self._message_type)

    def is_stopped(self) -> bool:
        return False


class MessageParsingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        root = Path(self._directory.name)
        self.image = root / "image.png"
        self.audio = root / "voice.wav"
        self.image.write_bytes(PNG)
        self.audio.write_bytes(WAV)
        self.client = httpx.AsyncClient()
        media = MediaResolver(self.client, root / "temporary", 1)
        self.adapter = AstrBotEventAdapter(
            PlatformIdentityMapper(),
            ImageResolver(media, 1024),
            AudioResolver(media, 1024, 5000, root / "temporary", "ffmpeg", 1),
            ("Lumi",),
            True,
            True,
            True,
        )

    async def asyncTearDown(self) -> None:
        await self.client.aclose()
        self._directory.cleanup()

    async def test_plain_segments_keep_paragraphs_and_order(self) -> None:
        event, _ = await self.adapter.convert(
            FakeEvent([Comp.Plain("第一段\n"), Comp.Plain("第二段")])
        )
        self.assertEqual([item.type for item in event.segments], ["text", "text"])
        self.assertEqual(event.segments[0].text, "第一段\n")
        self.assertEqual(event.segments[1].text, "第二段")

    async def test_empty_typing_notification_has_no_supported_content(self) -> None:
        routing = self.adapter.routing_facts(FakeEvent([]))

        self.assertTrue(routing.is_private)
        self.assertTrue(routing.is_platform_message)
        self.assertEqual(routing.text, "")
        self.assertFalse(routing.has_supported_content)

    async def test_snowluma_input_status_notice_is_not_a_chat_message(self) -> None:
        # ROOT CAUSE:
        #
        # SnowLuma emits typing state as notice/notify/input_status. AstrBot
        # 4.26.7 converts a notice without group_id into FriendMessage, so a
        # private-message filter alone cannot distinguish it from user content.
        event = FakeEvent([])
        event.message_obj.raw_message = {
            "post_type": "notice",
            "notice_type": "notify",
            "sub_type": "input_status",
            "user_id": 1770249418,
            "event_type": 1,
            "status_text": "对方正在输入...",
        }

        routing = self.adapter.routing_facts(event)

        self.assertTrue(routing.is_private)
        self.assertFalse(routing.is_platform_message)
        self.assertFalse(routing.has_supported_content)

    async def test_onebot_private_message_is_a_chat_message(self) -> None:
        event = FakeEvent([Comp.Plain("hello")])
        event.message_obj.raw_message = {
            "post_type": "message",
            "message_type": "private",
            "sub_type": "friend",
            "user_id": 1770249418,
            "message": [{"type": "text", "data": {"text": "hello"}}],
        }

        routing = self.adapter.routing_facts(event)

        self.assertTrue(routing.is_private)
        self.assertTrue(routing.is_platform_message)
        self.assertTrue(routing.has_supported_content)

    async def test_message_type_prevents_group_event_from_looking_private(self) -> None:
        event = FakeEvent(
            [Comp.Plain("group message")],
            group_id="",
            message_type="GroupMessage",
        )

        facts = self.adapter.routing_facts(event)

        self.assertFalse(facts.is_private)
        self.assertTrue(facts.is_group)

    async def test_image_and_audio_keep_original_chain_order(self) -> None:
        components = [
            Comp.Plain("文字一"),
            Comp.Image.fromFileSystem(str(self.image)),
            Comp.Plain("文字二"),
            Comp.Record.fromFileSystem(str(self.audio)),
        ]
        event, temporary = await self.adapter.convert(FakeEvent(components))
        self.assertEqual(
            [item.type for item in event.segments],
            ["text", "image", "text", "audio"],
        )
        self.assertEqual(temporary, [])

    async def test_multiple_images_and_audio_are_not_collapsed(self) -> None:
        components = [
            Comp.Image.fromFileSystem(str(self.image)),
            Comp.Image.fromFileSystem(str(self.image)),
            Comp.Record.fromFileSystem(str(self.audio)),
            Comp.Record.fromFileSystem(str(self.audio)),
        ]
        event, _ = await self.adapter.convert(FakeEvent(components))
        self.assertEqual(
            [item.type for item in event.segments],
            ["image", "image", "audio", "audio"],
        )

    async def test_group_sticker_learning_does_not_require_vision_module(self) -> None:
        root = Path(self._directory.name)
        media = MediaResolver(self.client, root / "temporary", 1)
        adapter = AstrBotEventAdapter(
            PlatformIdentityMapper(),
            ImageResolver(media, 1024),
            AudioResolver(media, 1024, 5000, root / "temporary", "ffmpeg", 1),
            ("Lumi",),
            False,
            True,
            True,
        )
        event = FakeEvent(
            [Comp.Image.fromFileSystem(str(self.image))],
            group_id="100",
        )

        facts = adapter.routing_facts(event)
        observation, temporary = await adapter.convert_group_observation(
            event,
            "default:100",
        )

        self.assertTrue(facts.has_supported_content)
        self.assertEqual([item.type for item in observation.segments], ["image"])
        self.assertEqual(temporary, [])

    async def test_empty_qq_record_is_resolved_through_onebot_get_record(self) -> None:
        event = FakeEvent([Comp.Record()])
        event.message_obj.raw_message = {
            "message": [{"type": "record", "data": {"file": "qq-record-token"}}]
        }

        class FakeBot:
            async def call_action(self, action: str, **params: object):
                self.action = action
                self.params = params
                return {"file": str(self_audio)}

        self_audio = self.audio
        bot = FakeBot()
        event.bot = bot

        perception, _ = await self.adapter.convert(event)

        self.assertEqual(perception.segments[0].type, "audio")
        self.assertEqual(perception.segments[0].mime_type, "audio/wav")
        self.assertEqual(bot.action, "get_record")
        self.assertEqual(
            bot.params, {"file": "qq-record-token", "out_format": "wav"}
        )

    async def test_qq_record_prefers_native_transcription(self) -> None:
        event = FakeEvent([Comp.Record.fromFileSystem(str(self.audio))])
        event.message_obj.message_id = 123456

        class FakeBot:
            async def call_action(self, action: str, **params: object):
                self.action = action
                self.params = params
                return {"data": {"text": "这是 QQ 返回的语音文字"}}

        bot = FakeBot()
        event.bot = bot

        perception, temporary = await self.adapter.convert(event)

        self.assertEqual(len(perception.segments), 1)
        self.assertEqual(perception.segments[0].type, "text")
        self.assertEqual(perception.segments[0].text, "这是 QQ 返回的语音文字")
        self.assertEqual(
            perception.segments[0].metadata["kind"], "auditory_transcript"
        )
        self.assertEqual(
            perception.segments[0].metadata["transcription_provider"], "qq_native"
        )
        self.assertTrue(perception.metadata["input_has_audio"])
        self.assertNotIn("qq_native_transcription_error", perception.metadata)
        self.assertEqual(temporary, [])
        self.assertEqual(bot.action, "fetch_ptt_text")
        self.assertEqual(bot.params, {"message_id": "123456"})

    async def test_qq_native_transcription_failure_falls_back_to_lumi_hearing(
        self,
    ) -> None:
        event = FakeEvent([Comp.Record.fromFileSystem(str(self.audio))])

        class OldNapCatBot:
            async def call_action(self, action: str, **params: object):
                self.action = action
                raise RuntimeError("unsupported action")

        bot = OldNapCatBot()
        event.bot = bot

        perception, _ = await self.adapter.convert(event)

        self.assertEqual(perception.segments[0].type, "audio")
        self.assertEqual(perception.segments[0].mime_type, "audio/wav")
        self.assertTrue(perception.metadata["input_has_audio"])
        self.assertEqual(
            perception.metadata["qq_native_transcription_error"],
            "RuntimeError: unsupported action",
        )
        self.assertEqual(bot.action, "fetch_ptt_text")

    async def test_own_mention_is_removed_but_other_mention_is_preserved(self) -> None:
        event, _ = await self.adapter.convert(
            FakeEvent(
                [
                    Comp.At(qq="20002", name="Lumi"),
                    Comp.Plain("你好"),
                    Comp.At(qq="30003", name="Moussy"),
                ],
                group_id="group-1",
            )
        )
        self.assertEqual([item.type for item in event.segments], ["text", "text"])
        self.assertEqual(event.segments[0].text, "你好")
        self.assertEqual(event.segments[1].text, "@Moussy")
        self.assertTrue(event.is_mention)

    async def test_quote_text_is_preserved_as_structured_metadata(self) -> None:
        reply = Comp.Reply(
            id="quoted-1",
            message_str="原消息",
            sender_id="30003",
            sender_nickname="Moussy",
        )
        event, _ = await self.adapter.convert(FakeEvent([reply, Comp.Plain("回复")]))
        self.assertEqual(event.segments[0].text, "原消息")
        self.assertEqual(event.segments[0].metadata["kind"], "quote")
