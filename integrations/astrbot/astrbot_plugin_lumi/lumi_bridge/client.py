from __future__ import annotations

import base64
import binascii
from typing import Any, Protocol

import httpx

from .exceptions import (
    HearingUnavailableError,
    LumiAuthenticationError,
    LumiIdentityUnboundError,
    LumiProtocolError,
    LumiTimeoutError,
    LumiUnavailableError,
    MediaTooLargeError,
    VisionUnavailableError,
)
from .models import (
    LumiHealth,
    LumiLearningPolicy,
    LumiOutputSegment,
    LumiPerceptionEvent,
    LumiResponse,
    LumiSpeech,
    LumiStudyGroup,
)


class LumiRuntimeClient(Protocol):
    async def perceive_and_respond(
        self, event: LumiPerceptionEvent
    ) -> LumiResponse: ...

    async def health_check(self) -> LumiHealth: ...

    async def learning_policy(self) -> LumiLearningPolicy: ...

    async def observe_group(self, event: LumiPerceptionEvent) -> None: ...

    async def synthesize_speech(self, text: str) -> LumiSpeech: ...

    async def close(self) -> None: ...


class HttpLumiRuntimeClient:
    """Calls either Lumi Server or the desktop client's local perception bridge."""

    def __init__(
        self,
        endpoint: str,
        api_token: str,
        request_timeout_seconds: float,
        connect_timeout_seconds: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_token = api_token
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                request_timeout_seconds, connect=connect_timeout_seconds
            ),
            transport=transport,
        )

    async def perceive_and_respond(self, event: LumiPerceptionEvent) -> LumiResponse:
        if not self._api_token:
            raise LumiAuthenticationError("Lumi integration token is not configured")
        try:
            response = await self._client.post(
                f"{self._endpoint}/api/lumi/integrations/astrbot/perceive",
                json=event.to_wire(),
                headers={"Authorization": f"Bearer {self._api_token}"},
            )
        except httpx.TimeoutException as error:
            raise LumiTimeoutError("Lumi did not finish the turn in time") from error
        except httpx.HTTPError as error:
            raise LumiUnavailableError("Lumi runtime is unavailable") from error
        self._raise_for_response(response)
        try:
            payload = response.json()
            segments = [
                LumiOutputSegment(
                    type=item["type"],
                    text=item.get("text"),
                    url=item.get("url"),
                    local_path=item.get("local_path"),
                    mime_type=item.get("mime_type"),
                    data_base64=item.get("data_base64"),
                    metadata=item.get("metadata") or {},
                )
                for item in payload.get("segments", [])
                if isinstance(item, dict)
                and item.get("type") in {"text", "image", "audio", "file"}
            ]
            return LumiResponse(
                response_id=str(payload["response_id"]),
                text=_optional_text(payload.get("text")),
                segments=segments,
                metadata=payload.get("metadata") or {},
            )
        except (KeyError, TypeError, ValueError) as error:
            raise LumiProtocolError("Lumi returned an invalid response") from error

    async def health_check(self) -> LumiHealth:
        try:
            response = await self._client.get(
                f"{self._endpoint}/api/lumi/integrations/astrbot/health",
                headers=(
                    {"Authorization": f"Bearer {self._api_token}"}
                    if self._api_token
                    else {}
                ),
            )
        except httpx.HTTPError as error:
            return LumiHealth(False, False, False, detail=str(error))
        if response.status_code != 200:
            return LumiHealth(
                False,
                False,
                False,
                detail=_safe_error_message(response, _safe_error_detail(response)),
            )
        try:
            payload: dict[str, Any] = response.json()
        except (TypeError, ValueError):
            return LumiHealth(
                False,
                False,
                False,
                detail="Lumi returned an invalid health response",
            )
        return LumiHealth(
            available=payload.get("status") == "ok",
            vision=bool(payload.get("vision")),
            hearing=bool(payload.get("hearing")),
            version=_optional_text(payload.get("server_version")),
            detail=_optional_text(payload.get("detail")),
        )

    async def learning_policy(self) -> LumiLearningPolicy:
        if not self._api_token:
            raise LumiAuthenticationError("Lumi integration token is not configured")
        try:
            response = await self._client.get(
                f"{self._endpoint}/api/lumi/integrations/astrbot/learning-policy",
                headers={"Authorization": f"Bearer {self._api_token}"},
            )
        except httpx.HTTPError as error:
            raise LumiUnavailableError("Lumi learning policy is unavailable") from error
        self._raise_for_response(response)
        try:
            payload = response.json()
            mode = payload["mode"]
            if mode not in {"normal", "observe_only"}:
                raise ValueError("invalid mode")
            groups = tuple(
                LumiStudyGroup(
                    source_id=str(item["source_id"]),
                    platform_instance_id=str(item["platform_instance_id"]),
                    group_id=str(item["group_id"]),
                    priority=(
                        item["priority"] if item.get("priority") in {"normal", "high"} else "normal"
                    ),
                )
                for item in payload.get("groups", [])
            )
            return LumiLearningPolicy(mode=mode, groups=groups)
        except (KeyError, TypeError, ValueError) as error:
            raise LumiProtocolError("Lumi returned an invalid learning policy") from error

    async def observe_group(self, event: LumiPerceptionEvent) -> None:
        if not self._api_token:
            raise LumiAuthenticationError("Lumi integration token is not configured")
        try:
            response = await self._client.post(
                f"{self._endpoint}/api/lumi/integrations/astrbot/observe",
                json=event.to_wire(),
                headers={"Authorization": f"Bearer {self._api_token}"},
            )
        except httpx.TimeoutException as error:
            raise LumiTimeoutError("Lumi did not accept the group observation in time") from error
        except httpx.HTTPError as error:
            raise LumiUnavailableError("Lumi group observation endpoint is unavailable") from error
        self._raise_for_response(response)

    async def synthesize_speech(self, text: str) -> LumiSpeech:
        if not self._api_token:
            raise LumiAuthenticationError("Lumi integration token is not configured")
        try:
            response = await self._client.post(
                f"{self._endpoint}/api/lumi/integrations/astrbot/speech",
                json={"text": text},
                headers={"Authorization": f"Bearer {self._api_token}"},
            )
        except httpx.TimeoutException as error:
            raise LumiTimeoutError("Lumi did not finish speech synthesis in time") from error
        except httpx.HTTPError as error:
            raise LumiUnavailableError("Lumi speech runtime is unavailable") from error
        self._raise_for_response(response)
        try:
            payload = response.json()
            data = base64.b64decode(str(payload["data_base64"]), validate=True)
            mime_type = str(payload["mime_type"])
        except (KeyError, TypeError, ValueError, binascii.Error) as error:
            raise LumiProtocolError("Lumi returned invalid speech audio") from error
        if not data or not mime_type.startswith("audio/"):
            raise LumiProtocolError("Lumi returned invalid speech audio")
        return LumiSpeech(data=data, mime_type=mime_type)

    async def close(self) -> None:
        await self._client.aclose()

    @staticmethod
    def _raise_for_response(response: httpx.Response) -> None:
        detail = _safe_error_detail(response)
        if response.status_code == 403 and detail == "identity_unbound":
            raise LumiIdentityUnboundError(
                "This platform account is not bound to a Lumi person"
            )
        if response.status_code in {401, 403}:
            raise LumiAuthenticationError("Lumi rejected the integration token")
        if response.status_code == 408 or response.status_code == 504:
            raise LumiTimeoutError("Lumi timed out while processing the event")
        if response.status_code == 413:
            raise MediaTooLargeError("Lumi rejected media that exceeds its limit")
        if response.status_code in {424, 503} and detail == "vision_unavailable":
            raise VisionUnavailableError(
                _safe_error_message(response, "Lumi vision is not configured")
            )
        if response.status_code in {424, 503} and detail == "hearing_unavailable":
            raise HearingUnavailableError(
                _safe_error_message(response, "Lumi hearing is not configured")
            )
        if response.status_code == 503 and detail == "runtime_not_ready":
            raise LumiUnavailableError(
                _safe_error_message(
                    response,
                    "Lumi local runtime is still starting or has no active model",
                )
            )
        if response.status_code >= 500:
            raise LumiUnavailableError(
                _safe_error_message(
                    response, "Lumi runtime failed to process the event"
                )
            )
        if response.status_code >= 400:
            raise LumiProtocolError(
                _safe_error_message(
                    response, f"Lumi rejected the event: {detail}"
                )
            )


def _safe_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return f"HTTP {response.status_code}"
    detail = payload.get("code") or payload.get("error")
    return str(detail)[:200] if detail else f"HTTP {response.status_code}"


def _safe_error_message(response: httpx.Response, fallback: str) -> str:
    try:
        payload = response.json()
    except ValueError:
        return fallback
    message = payload.get("error")
    return str(message)[:300] if message else fallback


def _optional_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
