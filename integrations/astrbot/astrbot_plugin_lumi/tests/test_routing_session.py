from __future__ import annotations

import asyncio
import unittest

from lumi_bridge.config import LumiPluginConfig
from lumi_bridge.exceptions import DuplicateEventError
from lumi_bridge.routing import RoutingFacts, decide_routing
from lumi_bridge.session import SessionCoordinator


def config(**overrides: object) -> LumiPluginConfig:
    return LumiPluginConfig.from_mapping(dict(overrides))


def facts(**overrides: object) -> RoutingFacts:
    values: dict[str, object] = {
        "platform_instance_id": "default",
        "sender_id": "1770249418",
        "is_platform_message": True,
        "is_private": True,
        "is_group": False,
        "is_mention": False,
        "is_wake": False,
        "is_self_message": False,
        "is_stopped": False,
        "has_supported_content": True,
        "text": "hello",
    }
    values.update(overrides)
    return RoutingFacts(**values)  # type: ignore[arg-type]


class RoutingTests(unittest.TestCase):
    def test_desktop_target_uses_local_gateway_default(self) -> None:
        configured = config(lumi_target="desktop_local")

        self.assertEqual(configured.lumi_target, "desktop_local")
        self.assertEqual(configured.lumi_endpoint, "http://127.0.0.1:6132")
        self.assertEqual(configured.speech_endpoint, "http://127.0.0.1:6132")

    def test_legacy_config_keeps_server_default(self) -> None:
        configured = config()

        self.assertEqual(configured.lumi_target, "server")
        self.assertEqual(configured.lumi_endpoint, "http://127.0.0.1:6130")
        self.assertEqual(configured.speech_endpoint, "http://127.0.0.1:6132")

    def test_independent_private_and_group_gates_can_both_be_enabled(self) -> None:
        configured = config(
            private_reply_enabled=True,
            group_observation_enabled=True,
        )

        self.assertTrue(configured.private_reply_enabled)
        self.assertTrue(configured.group_observation_enabled)

    def test_legacy_private_gate_is_used_only_when_new_gate_is_missing(self) -> None:
        legacy = config(handle_private_messages=False)
        migrated = config(
            handle_private_messages=False,
            private_reply_enabled=True,
        )

        self.assertFalse(legacy.private_reply_enabled)
        self.assertTrue(migrated.private_reply_enabled)

    def test_server_target_can_use_a_distinct_desktop_speech_token(self) -> None:
        configured = config(
            lumi_target="server",
            lumi_api_token="server-token",
            speech_api_token="desktop-token",
        )

        self.assertEqual(configured.lumi_api_token, "server-token")
        self.assertEqual(configured.speech_api_token, "desktop-token")

    def test_invalid_runtime_target_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported lumi_target"):
            config(lumi_target="not-lumi")

    def test_voice_reply_modes_follow_the_configured_policy(self) -> None:
        self.assertFalse(
            config(voice_reply_mode="all_text").should_reply_with_voice(
                input_has_audio=True, random_value=0
            )
        )
        self.assertTrue(
            config(voice_reply_mode="all_voice").should_reply_with_voice(
                input_has_audio=False, random_value=1
            )
        )
        self.assertTrue(
            config(
                voice_reply_mode="random", random_voice_probability=0.4
            ).should_reply_with_voice(input_has_audio=False, random_value=0.39)
        )
        self.assertFalse(
            config(
                voice_reply_mode="random", random_voice_probability=0.4
            ).should_reply_with_voice(input_has_audio=False, random_value=0.4)
        )
        self.assertTrue(
            config(voice_reply_mode="mirror_input_audio").should_reply_with_voice(
                input_has_audio=True, random_value=1
            )
        )

    def test_private_messages_default_to_lumi(self) -> None:
        self.assertTrue(decide_routing(config(), facts()).handle)

    def test_empty_private_notification_is_ignored(self) -> None:
        decision = decide_routing(
            config(),
            facts(text="", has_supported_content=False),
        )

        self.assertFalse(decision.handle)
        self.assertFalse(decision.suppress_default)
        self.assertEqual(decision.reason, "no-supported-content")

    def test_protocol_notice_is_rejected_before_content_routing(self) -> None:
        decision = decide_routing(
            config(),
            facts(is_platform_message=False, has_supported_content=True),
        )

        self.assertFalse(decision.handle)
        self.assertFalse(decision.suppress_default)
        self.assertEqual(decision.reason, "non-message-event")

    def test_unmentioned_group_message_is_ignored(self) -> None:
        decision = decide_routing(
            config(),
            facts(is_private=False, is_group=True),
        )
        self.assertFalse(decision.handle)

    def test_group_mention_is_ignored_in_private_only_mode(self) -> None:
        decision = decide_routing(
            config(),
            facts(is_private=False, is_group=True, is_mention=True),
        )
        self.assertFalse(decision.handle)
        self.assertEqual(decision.reason, "group-disabled")

    def test_wake_word_group_message_is_ignored_in_private_only_mode(self) -> None:
        decision = decide_routing(
            config(),
            facts(is_private=False, is_group=True, is_wake=True),
        )
        self.assertFalse(decision.handle)
        self.assertEqual(decision.reason, "group-disabled")

    def test_private_identity_is_delegated_to_lumi_authorization(self) -> None:
        decision = decide_routing(config(), facts(sender_id="2747277822"))

        self.assertTrue(decision.handle)
        self.assertEqual(decision.reason, "private")

    def test_astrbot_commands_bypass_lumi(self) -> None:
        self.assertEqual(
            decide_routing(config(), facts(text="/help")).reason,
            "command",
        )

    def test_stopped_and_self_events_are_ignored(self) -> None:
        self.assertFalse(decide_routing(config(), facts(is_stopped=True)).handle)
        self.assertFalse(decide_routing(config(), facts(is_self_message=True)).handle)


class SessionCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_conversation_runs_in_order(self) -> None:
        coordinator = SessionCoordinator()
        order: list[str] = []

        async def first() -> str:
            order.append("first-start")
            await asyncio.sleep(0.02)
            order.append("first-end")
            return "first"

        async def second() -> str:
            order.append("second")
            return "second"

        results = await asyncio.gather(
            coordinator.run("same", "event-1", first),
            coordinator.run("same", "event-2", second),
        )
        self.assertEqual(results, ["first", "second"])
        self.assertEqual(order, ["first-start", "first-end", "second"])

    async def test_different_conversations_run_concurrently(self) -> None:
        coordinator = SessionCoordinator()
        both_started = asyncio.Event()
        started = 0

        async def operation() -> None:
            nonlocal started
            started += 1
            if started == 2:
                both_started.set()
            await asyncio.wait_for(both_started.wait(), timeout=0.2)

        await asyncio.gather(
            coordinator.run("a", "event-a", operation),
            coordinator.run("b", "event-b", operation),
        )
        self.assertEqual(started, 2)

    async def test_duplicate_event_is_rejected(self) -> None:
        coordinator = SessionCoordinator()

        async def operation() -> str:
            return "ok"

        self.assertEqual(
            await coordinator.run("conversation", "event", operation),
            "ok",
        )
        with self.assertRaises(DuplicateEventError):
            await coordinator.run("conversation", "event", operation)

    async def test_failed_event_can_be_retried_and_close_clears_state(self) -> None:
        coordinator = SessionCoordinator()

        async def failing() -> None:
            raise RuntimeError("failed")

        with self.assertRaises(RuntimeError):
            await coordinator.run("conversation", "event", failing)

        async def success() -> str:
            return "ok"

        self.assertEqual(
            await coordinator.run("conversation", "event", success),
            "ok",
        )
        await coordinator.close()
        self.assertEqual(
            await coordinator.run("conversation", "event", success),
            "ok",
        )
