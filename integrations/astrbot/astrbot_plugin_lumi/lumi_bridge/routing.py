from __future__ import annotations

from dataclasses import dataclass

from .config import LumiPluginConfig


@dataclass(frozen=True, slots=True)
class RoutingFacts:
    platform_instance_id: str
    sender_id: str
    is_platform_message: bool
    is_private: bool
    is_group: bool
    is_mention: bool
    is_wake: bool
    is_self_message: bool
    is_stopped: bool
    has_supported_content: bool
    text: str


@dataclass(frozen=True, slots=True)
class RoutingDecision:
    handle: bool
    reason: str
    suppress_default: bool = False


def decide_routing(config: LumiPluginConfig, facts: RoutingFacts) -> RoutingDecision:
    if not config.enabled or config.trigger_mode == "disabled":
        return RoutingDecision(False, "disabled")
    if facts.is_stopped:
        return RoutingDecision(False, "already-stopped")
    if facts.is_self_message:
        return RoutingDecision(False, "self-message")
    if not facts.is_platform_message:
        return RoutingDecision(False, "non-message-event")
    if not facts.has_supported_content:
        return RoutingDecision(False, "no-supported-content")
    stripped = facts.text.lstrip()
    if (
        config.ignore_command_messages
        and stripped
        and any(stripped.startswith(prefix) for prefix in config.command_prefixes)
    ):
        return RoutingDecision(False, "command")
    if facts.is_private:
        if not config.handle_private_messages:
            return RoutingDecision(False, "private-disabled")
        if config.trigger_mode in {"private_always", "all_messages"}:
            return RoutingDecision(True, "private")
        if config.trigger_mode == "wake_only":
            return RoutingDecision(facts.is_wake, "private-wake")
        return RoutingDecision(facts.is_mention, "private-mention")
    if facts.is_group:
        return RoutingDecision(False, "group-disabled")
    return RoutingDecision(False, "unsupported-event")
