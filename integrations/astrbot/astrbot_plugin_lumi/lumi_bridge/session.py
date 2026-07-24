from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import TypeVar

from .exceptions import DuplicateEventError

T = TypeVar("T")


class SessionCoordinator:
    """Serializes one conversation while allowing unrelated conversations to run."""

    def __init__(self, max_seen_events: int = 4096, ttl_seconds: float = 86400) -> None:
        self._locks: dict[str, asyncio.Lock] = {}
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._max_seen_events = max_seen_events
        self._ttl_seconds = ttl_seconds
        self._guard = asyncio.Lock()

    async def run(
        self,
        conversation_id: str,
        event_id: str,
        operation: Callable[[], Awaitable[T]],
    ) -> T:
        async with self._guard:
            self._prune()
            if event_id in self._seen:
                raise DuplicateEventError(f"duplicate event: {event_id}")
            lock = self._locks.setdefault(conversation_id, asyncio.Lock())

        async with lock:
            async with self._guard:
                self._prune()
                if event_id in self._seen:
                    raise DuplicateEventError(f"duplicate event: {event_id}")
                self._seen[event_id] = time.monotonic()
                self._seen.move_to_end(event_id)
            try:
                return await operation()
            except Exception:
                async with self._guard:
                    self._seen.pop(event_id, None)
                raise

    async def close(self) -> None:
        async with self._guard:
            self._locks.clear()
            self._seen.clear()

    def _prune(self) -> None:
        threshold = time.monotonic() - self._ttl_seconds
        while self._seen:
            event_id, created_at = next(iter(self._seen.items()))
            if created_at >= threshold and len(self._seen) <= self._max_seen_events:
                break
            self._seen.pop(event_id, None)
