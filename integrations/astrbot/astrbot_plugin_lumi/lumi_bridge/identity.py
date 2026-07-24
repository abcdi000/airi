from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class IdentityResolution:
    person_key: str
    conversation_key: str


class IdentityMapper(Protocol):
    async def resolve_person(
        self, platform_instance_id: str, sender_id: str
    ) -> str: ...

    async def resolve_conversation(self, unified_msg_origin: str) -> str: ...


class PlatformIdentityMapper:
    """Keeps external identities collision-free without guessing cross-platform links."""

    async def resolve_person(self, platform_instance_id: str, sender_id: str) -> str:
        return f"{platform_instance_id}:{sender_id}"

    async def resolve_conversation(self, unified_msg_origin: str) -> str:
        return unified_msg_origin
