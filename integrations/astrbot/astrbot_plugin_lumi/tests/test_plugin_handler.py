from __future__ import annotations

import base64
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace


def decorator(*_args, **_kwargs):
    def apply(function):
        return function

    return apply


class Plain:
    def __init__(self, text: str) -> None:
        self.text = text


class Image:
    @classmethod
    def fromFileSystem(cls, path: str):
        return SimpleNamespace(type="image", path=path)

    @classmethod
    def fromURL(cls, url: str):
        return SimpleNamespace(type="image", url=url)


class Record:
    @classmethod
    def fromFileSystem(cls, path: str):
        return SimpleNamespace(type="audio", path=path)

    @classmethod
    def fromURL(cls, url: str):
        return SimpleNamespace(type="audio", url=url)


class Star:
    def __init__(self, context, config) -> None:
        self.context = context
        self.config = config
        self.name = "astrbot_plugin_lumi"


filter_api = SimpleNamespace(
    event_message_type=decorator,
    permission_type=decorator,
    command=decorator,
    EventMessageType=SimpleNamespace(
        ALL="all", PRIVATE_MESSAGE="private", GROUP_MESSAGE="group"
    ),
    PermissionType=SimpleNamespace(ADMIN="admin"),
)
components = ModuleType("astrbot.api.message_components")
components.BaseMessageComponent = object
components.Plain = Plain
components.Image = Image
components.Record = Record
event_api = ModuleType("astrbot.api.event")
event_api.AstrMessageEvent = object
event_api.filter = filter_api
star_api = ModuleType("astrbot.api.star")
star_api.Context = object
star_api.Star = Star
web_api = ModuleType("astrbot.api.web")
web_api.json_response = lambda payload: payload
api = ModuleType("astrbot.api")
api.AstrBotConfig = dict
api.message_components = components
astrbot = ModuleType("astrbot")
astrbot.logger = SimpleNamespace(
    debug=lambda *_args, **_kwargs: None,
    info=lambda *_args, **_kwargs: None,
    warning=lambda *_args, **_kwargs: None,
    exception=lambda *_args, **_kwargs: None,
)
sys.modules["astrbot"] = astrbot
sys.modules["astrbot.api"] = api
sys.modules["astrbot.api.message_components"] = components
sys.modules["astrbot.api.event"] = event_api
sys.modules["astrbot.api.star"] = star_api
sys.modules["astrbot.api.web"] = web_api
sys.path.insert(0, str(Path(__file__).parents[2]))

# NOTICE:
# Importing after the public API fixture is intentional. AstrBot's source
# contract is separately verified against 4.26.7 in test_astrbot_source_contract.
from astrbot_plugin_lumi.main import Main  # noqa: E402
from astrbot_plugin_lumi.lumi_bridge.config import LumiPluginConfig  # noqa: E402
from astrbot_plugin_lumi.lumi_bridge.exceptions import (  # noqa: E402
    LumiAuthenticationError,
    LumiIdentityUnboundError,
    LumiUnavailableError,
)
from astrbot_plugin_lumi.lumi_bridge.models import (  # noqa: E402
    LumiHealth,
    LumiLearningPolicy,
    LumiOutputSegment,
    LumiPerceptionEvent,
    LumiResponse,
    LumiSpeech,
    LumiStudyGroup,
    LumiTextSegment,
)
from astrbot_plugin_lumi.lumi_bridge.routing import RoutingFacts  # noqa: E402


class FakeEvent:
    def __init__(self, send_error: Exception | None = None) -> None:
        self.message_obj = SimpleNamespace(message_id="message-1")
        self.call_llm_values: list[bool] = []
        self.sent: list[object] = []
        self.stopped = False
        self.send_error = send_error

    def should_call_llm(self, value: bool) -> None:
        self.call_llm_values.append(value)

    async def send(self, result: object) -> None:
        if self.send_error:
            raise self.send_error
        self.sent.append(result)

    def chain_result(self, chain: list[object]) -> list[object]:
        return chain

    def plain_result(self, text: str) -> str:
        return text

    def stop_event(self) -> None:
        self.stopped = True

    def get_platform_id(self) -> str:
        return "qq-bot-1"

    def get_group_id(self) -> str:
        return "100"


class FakeAdapter:
    def __init__(self, facts: RoutingFacts | None = None) -> None:
        self._facts = facts or RoutingFacts(
            platform_instance_id="default",
            sender_id="1770249418",
            is_platform_message=True,
            is_private=True,
            is_group=False,
            is_mention=False,
            is_wake=False,
            is_self_message=False,
            is_stopped=False,
            has_supported_content=True,
            text="hello",
        )

    def routing_facts(self, _event: FakeEvent) -> RoutingFacts:
        return self._facts

    async def convert(self, _event: FakeEvent):
        return perception(), []

    async def convert_group_observation(
        self, _event: FakeEvent
    ) -> tuple[LumiPerceptionEvent, list[str]]:
        event = perception()
        event.is_private = False
        event.is_group = True
        event.group_id = "100"
        return event, []


class FakeSessions:
    async def run(self, _conversation: str, _event: str, operation):
        return await operation()


class FakeClient:
    def __init__(
        self,
        error: Exception | None = None,
        response: LumiResponse | None = None,
    ) -> None:
        self.error = error
        self.response = response or LumiResponse("reply-1", "Lumi reply")
        self.calls = 0
        self.speech_calls: list[str] = []

    async def perceive_and_respond(self, _event: LumiPerceptionEvent) -> LumiResponse:
        self.calls += 1
        if self.error:
            raise self.error
        return self.response

    async def health_check(self) -> LumiHealth:
        return LumiHealth(
            available=True,
            vision=True,
            hearing=False,
            version="lumi-test",
        )

    async def synthesize_speech(self, text: str) -> LumiSpeech:
        self.speech_calls.append(text)
        return LumiSpeech(b"RIFF0000WAVEaudio", "audio/wav")

    async def learning_policy(self) -> LumiLearningPolicy:
        return LumiLearningPolicy(mode="normal", groups=())

    async def observe_group(self, _event: LumiPerceptionEvent) -> None:
        self.calls += 1


class FakeService:
    def __init__(
        self,
        *,
        error: Exception | None = None,
        failure_policy: str = "friendly_error",
        routing_facts: RoutingFacts | None = None,
        response: LumiResponse | None = None,
        voice_reply_mode: str = "all_text",
    ) -> None:
        self.config = LumiPluginConfig.from_mapping(
            {
                "failure_policy": failure_policy,
                "voice_reply_mode": voice_reply_mode,
            }
        )
        self.adapter = FakeAdapter(routing_facts)
        self.sessions = FakeSessions()
        self.client = FakeClient(error, response)
        self.speech_client = self.client
        self._temporary = tempfile.TemporaryDirectory()
        self.temp_directory = Path(self._temporary.name)
        self.closed = False

    async def close(self) -> None:
        self.closed = True
        self._temporary.cleanup()


def perception() -> LumiPerceptionEvent:
    return LumiPerceptionEvent(
        event_id="qq-bot-1:message-1",
        platform="aiocqhttp",
        platform_instance_id="qq-bot-1",
        unified_session_id="aiocqhttp:friend:10001",
        conversation_id="aiocqhttp:friend:10001",
        sender_id="10001",
        sender_name="Doggy",
        group_id=None,
        message_id="message-1",
        timestamp=1,
        is_private=True,
        is_group=False,
        is_mention=False,
        segments=[LumiTextSegment(text="hello")],
    )


class PluginHandlerTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_suppresses_default_llm_and_sends_only_lumi(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService()
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(event.call_llm_values, [True])
        self.assertEqual(len(event.sent), 1)
        self.assertEqual(event.sent[0][0].text, "Lumi reply")
        self.assertTrue(event.stopped)

    async def test_multi_bubble_reply_is_sent_as_separate_qq_messages(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            response=LumiResponse(
                "reply-1",
                "第一条。\n\n第二条补充。\n\n第三条。",
            )
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(len(event.sent), 3)
        self.assertEqual(
            [message[0].text for message in event.sent],
            ["第一条。", "第二条补充。", "第三条。"],
        )
        self.assertTrue(event.stopped)

    async def test_sticker_output_is_sent_as_an_image_component(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            response=LumiResponse(
                "reply-1",
                "确实",
                segments=[
                    LumiOutputSegment(type="text", text="确实"),
                    LumiOutputSegment(
                        type="image",
                        mime_type="image/png",
                        data_base64=base64.b64encode(b"\x89PNG\r\n\x1a\n").decode(
                            "ascii"
                        ),
                    ),
                ],
            )
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(len(event.sent), 2)
        self.assertEqual(event.sent[0][0].text, "确实")
        self.assertEqual(event.sent[1][0].type, "image")
        self.assertTrue(Path(event.sent[1][0].path).name.startswith("lumi-sticker-"))

    async def test_voice_mode_synthesizes_each_bubble_as_a_complete_record(
        self,
    ) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            response=LumiResponse("reply-1", "第一条。\n\n第二条。"),
            voice_reply_mode="all_voice",
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(plugin._service.client.speech_calls, ["第一条。", "第二条。"])
        self.assertEqual(len(event.sent), 2)
        self.assertEqual([message[0].type for message in event.sent], ["audio", "audio"])

    async def test_identity_rejected_by_lumi_is_silent_and_stops_default_llm(
        self,
    ) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            error=LumiIdentityUnboundError("not bound"),
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(plugin._service.client.calls, 1)
        self.assertEqual(event.sent, [])
        self.assertEqual(event.call_llm_values, [True])
        self.assertTrue(event.stopped)

    async def test_group_message_is_not_claimed_by_lumi(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            routing_facts=RoutingFacts(
                platform_instance_id="default",
                sender_id="1770249418",
                is_platform_message=True,
                is_private=False,
                is_group=True,
                is_mention=True,
                is_wake=True,
                is_self_message=False,
                is_stopped=False,
                has_supported_content=True,
                text="@Lumi hello",
            )
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(plugin._service.client.calls, 0)
        self.assertEqual(event.sent, [])
        self.assertEqual(event.call_llm_values, [])
        self.assertFalse(event.stopped)

    async def test_learning_group_is_observed_without_any_reply(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            routing_facts=RoutingFacts(
                platform_instance_id="qq-bot-1",
                sender_id="300",
                is_platform_message=True,
                is_private=False,
                is_group=True,
                is_mention=False,
                is_wake=False,
                is_self_message=False,
                is_stopped=False,
                has_supported_content=True,
                text="这也太炸了",
            )
        )
        plugin._learning_policy = LumiLearningPolicy(
            mode="observe_only",
            groups=(
                LumiStudyGroup(
                    source_id="qq-bot-1:100",
                    platform_instance_id="qq-bot-1",
                    group_id="100",
                    priority="high",
                ),
            ),
        )
        plugin._learning_policy_expires_at = time.monotonic() + 60
        event = FakeEvent()

        await plugin.observe_group_message(event)

        self.assertEqual(plugin._service.client.calls, 1)
        self.assertEqual(event.sent, [])
        self.assertEqual(event.call_llm_values, [True])
        self.assertTrue(event.stopped)

    async def test_empty_private_notification_is_not_claimed_or_replied_to(
        self,
    ) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            routing_facts=RoutingFacts(
                platform_instance_id="default",
                sender_id="1770249418",
                is_platform_message=True,
                is_private=True,
                is_group=False,
                is_mention=False,
                is_wake=False,
                is_self_message=False,
                is_stopped=False,
                has_supported_content=False,
                text="",
            )
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(plugin._service.client.calls, 0)
        self.assertEqual(event.sent, [])
        self.assertEqual(event.call_llm_values, [])
        self.assertFalse(event.stopped)

    async def test_snowluma_input_status_notice_is_not_claimed_or_replied_to(
        self,
    ) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            routing_facts=RoutingFacts(
                platform_instance_id="default",
                sender_id="1770249418",
                is_platform_message=False,
                is_private=True,
                is_group=False,
                is_mention=False,
                is_wake=False,
                is_self_message=False,
                is_stopped=False,
                has_supported_content=False,
                text="",
            )
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(plugin._service.client.calls, 0)
        self.assertEqual(event.sent, [])
        self.assertEqual(event.call_llm_values, [])
        self.assertFalse(event.stopped)

    async def test_failure_does_not_switch_personality_by_default(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(error=LumiUnavailableError("offline"))
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(event.call_llm_values, [True])
        self.assertEqual(
            event.sent,
            ["Lumi 现在暂时无法回应，请稍后再和我说一次。"],
        )
        self.assertTrue(event.stopped)

    async def test_platform_rejection_does_not_escape_failure_handler(self) -> None:
        # ROOT CAUSE:
        #
        # AstrBot's aiocqhttp adapter can reject a private reply when the QQ
        # account is not a friend. The previous error path re-raised that
        # delivery error, so AstrBot reported the Lumi handler itself as broken.
        plugin = Main.__new__(Main)
        plugin._service = FakeService(error=LumiUnavailableError("offline"))
        event = FakeEvent(send_error=RuntimeError("private message rejected"))

        await plugin.bridge_message(event)

        self.assertEqual(event.call_llm_values, [True])
        self.assertEqual(event.sent, [])
        self.assertTrue(event.stopped)

    async def test_missing_token_returns_an_actionable_message(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            error=LumiAuthenticationError(
                "Lumi integration token is not configured"
            )
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(
            event.sent,
            [
                "Lumi 连接尚未配置：请在 AstrBot 插件设置中填写 "
                "桌面 Lumi 或 Lumi Server Manager 生成的集成令牌。"
            ],
        )
        self.assertTrue(event.stopped)

    async def test_explicit_fallback_restores_astrbot_default_llm(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService(
            error=LumiUnavailableError("offline"),
            failure_policy="allow_default_llm_fallback",
        )
        event = FakeEvent()

        await plugin.bridge_message(event)

        self.assertEqual(event.call_llm_values, [True, False])
        self.assertEqual(event.sent, [])
        self.assertFalse(event.stopped)

    async def test_terminate_closes_bridge_resources(self) -> None:
        plugin = Main.__new__(Main)
        service = FakeService()
        plugin._service = service

        await plugin.terminate()

        self.assertTrue(service.closed)

    async def test_reload_replaces_and_closes_previous_service(self) -> None:
        plugin = Main.__new__(Main)
        previous = FakeService()
        replacement = FakeService()
        plugin._service = previous
        plugin._build_service = lambda: replacement
        event = FakeEvent()

        results = [result async for result in plugin.lumi_reload(event)]

        self.assertEqual(results, ["Lumi bridge configuration reloaded."])
        self.assertIs(plugin._service, replacement)
        self.assertTrue(previous.closed)

    async def test_connection_page_returns_token_free_runtime_status(self) -> None:
        plugin = Main.__new__(Main)
        plugin._service = FakeService()

        result = await plugin.connection_test()

        self.assertTrue(result["available"])
        self.assertEqual(result["target"], "server")
        self.assertEqual(result["endpoint"], "http://127.0.0.1:6130")
        self.assertFalse(result["token_configured"])
        self.assertEqual(result["version"], "lumi-test")
        self.assertNotIn("lumi_api_token", result)
