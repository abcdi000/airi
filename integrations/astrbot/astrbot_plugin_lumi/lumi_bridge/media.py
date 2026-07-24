from __future__ import annotations

import base64
import binascii
import asyncio
import mimetypes
import os
import shutil
import tempfile
import wave
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote, urlparse, urlunparse

import httpx

from .exceptions import (
    AudioConversionError,
    MediaDownloadError,
    MediaTooLargeError,
    UnsupportedMediaError,
)
from .models import LumiAudioSegment, LumiImageSegment


@dataclass(frozen=True, slots=True)
class MediaReference:
    file: str | None = None
    url: str | None = None
    path: str | None = None
    mime_type: str | None = None
    duration_ms: int | None = None


@dataclass(frozen=True, slots=True)
class ResolvedMedia:
    data: bytes
    mime_type: str
    source_url: str | None
    local_path: str | None
    temporary_path: str | None


class MediaResolver:
    """Resolves AstrBot media without using AstrBot's vision or ASR providers."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        temp_directory: Path,
        download_timeout_seconds: float,
    ) -> None:
        self._client = client
        self._temp_directory = temp_directory
        self._download_timeout_seconds = download_timeout_seconds
        self._temp_directory.mkdir(parents=True, exist_ok=True)

    async def resolve(
        self,
        reference: MediaReference,
        *,
        kind: str,
        maximum_bytes: int,
    ) -> ResolvedMedia:
        local = _first_local_path(reference)
        if local is not None:
            data = await _read_bounded(local, maximum_bytes)
            return ResolvedMedia(
                data=data,
                mime_type=_detect_mime(data, reference.mime_type, local.name, kind),
                source_url=None,
                local_path=str(local),
                temporary_path=None,
            )

        source = reference.url or reference.file
        if not source:
            raise UnsupportedMediaError(f"{kind} component has no usable source")
        if source.startswith("base64://"):
            try:
                data = base64.b64decode(source.removeprefix("base64://"), validate=True)
            except (ValueError, binascii.Error) as error:
                raise UnsupportedMediaError(f"invalid base64 {kind}") from error
            _check_size(len(data), maximum_bytes, kind)
            return ResolvedMedia(
                data=data,
                mime_type=_detect_mime(data, reference.mime_type, None, kind),
                source_url=None,
                local_path=None,
                temporary_path=None,
            )
        parsed = urlparse(source)
        if parsed.scheme not in {"http", "https"}:
            raise UnsupportedMediaError(f"unsupported {kind} source")

        suffix = Path(parsed.path).suffix[:12]
        handle, temporary_name = tempfile.mkstemp(
            prefix=f"lumi-{kind}-", suffix=suffix, dir=self._temp_directory
        )
        os.close(handle)
        temporary_path = Path(temporary_name)
        total = 0
        chunks: list[bytes] = []
        try:
            async with self._client.stream(
                "GET",
                source,
                timeout=self._download_timeout_seconds,
                follow_redirects=True,
            ) as response:
                response.raise_for_status()
                content_length = int(response.headers.get("content-length", "0") or "0")
                if content_length:
                    _check_size(content_length, maximum_bytes, kind)
                with temporary_path.open("wb") as output:
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        _check_size(total, maximum_bytes, kind)
                        output.write(chunk)
                        chunks.append(chunk)
                data = b"".join(chunks)
                return ResolvedMedia(
                    data=data,
                    mime_type=_detect_mime(
                        data,
                        reference.mime_type or response.headers.get("content-type"),
                        temporary_path.name,
                        kind,
                    ),
                    source_url=source,
                    local_path=str(temporary_path),
                    temporary_path=str(temporary_path),
                )
        except MediaTooLargeError:
            temporary_path.unlink(missing_ok=True)
            raise
        except (httpx.HTTPError, OSError, ValueError) as error:
            temporary_path.unlink(missing_ok=True)
            raise MediaDownloadError(
                f"failed to download {kind} from {redact_url(source)}"
            ) from error


class ImageResolver:
    def __init__(self, media: MediaResolver, maximum_bytes: int) -> None:
        self._media = media
        self._maximum_bytes = maximum_bytes

    async def resolve(
        self, reference: MediaReference, metadata: dict[str, object] | None = None
    ) -> tuple[LumiImageSegment, str | None]:
        resolved = await self._media.resolve(
            reference, kind="image", maximum_bytes=self._maximum_bytes
        )
        return (
            LumiImageSegment(
                source_url=resolved.source_url,
                local_path=resolved.local_path,
                mime_type=resolved.mime_type,
                size_bytes=len(resolved.data),
                data_base64=base64.b64encode(resolved.data).decode("ascii"),
                metadata=dict(metadata or {}),
            ),
            resolved.temporary_path,
        )


class AudioResolver:
    def __init__(
        self,
        media: MediaResolver,
        maximum_bytes: int,
        maximum_duration_ms: int,
        temp_directory: Path,
        ffmpeg_path: str,
        conversion_timeout_seconds: float,
    ) -> None:
        self._media = media
        self._maximum_bytes = maximum_bytes
        self._maximum_duration_ms = maximum_duration_ms
        self._temp_directory = temp_directory
        self._ffmpeg_path = ffmpeg_path
        self._conversion_timeout_seconds = conversion_timeout_seconds

    async def resolve(
        self, reference: MediaReference, metadata: dict[str, object] | None = None
    ) -> tuple[LumiAudioSegment, str | None]:
        if (
            reference.duration_ms is not None
            and reference.duration_ms > self._maximum_duration_ms
        ):
            raise MediaTooLargeError(
                f"audio duration exceeds {self._maximum_duration_ms} ms"
            )
        resolved = await self._media.resolve(
            reference, kind="audio", maximum_bytes=self._maximum_bytes
        )
        if resolved.mime_type == "audio/silk":
            resolved = await self._convert_silk_to_wav(resolved)
        elif resolved.mime_type == "audio/amr":
            resolved = await self._convert_to_wav(resolved)
        return (
            LumiAudioSegment(
                source_url=resolved.source_url,
                local_path=resolved.local_path,
                mime_type=resolved.mime_type,
                size_bytes=len(resolved.data),
                duration_ms=reference.duration_ms,
                data_base64=base64.b64encode(resolved.data).decode("ascii"),
                metadata=dict(metadata or {}),
            ),
            resolved.temporary_path,
        )

    async def _convert_silk_to_wav(self, media: ResolvedMedia) -> ResolvedMedia:
        try:
            import pysilk
        except (ImportError, ModuleNotFoundError) as error:
            raise AudioConversionError(
                "silk-python is required to decode QQ voice messages; "
                "reload the plugin dependencies"
            ) from error

        handle, output_name = tempfile.mkstemp(
            prefix="lumi-audio-", suffix=".wav", dir=self._temp_directory
        )
        os.close(handle)
        output_path = Path(output_name)

        def decode() -> None:
            # Tencent voice payloads may prefix the normal SILK header with 0x02.
            payload = media.data[1:] if media.data.startswith(b"\x02") else media.data
            pcm = BytesIO()
            pysilk.decode(BytesIO(payload), pcm, 24000)
            pcm.seek(0)
            with wave.open(str(output_path), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(24000)
                wav.writeframes(pcm.read())

        try:
            await asyncio.to_thread(decode)
            data = await _read_bounded(output_path, self._maximum_bytes)
            return ResolvedMedia(
                data=data,
                mime_type="audio/wav",
                source_url=media.source_url,
                local_path=str(output_path),
                temporary_path=str(output_path),
            )
        except (MediaTooLargeError, OSError, wave.Error) as error:
            output_path.unlink(missing_ok=True)
            raise AudioConversionError(
                "Tencent SILK audio could not be decoded"
            ) from error
        except Exception as error:
            output_path.unlink(missing_ok=True)
            raise AudioConversionError(
                "Tencent SILK audio could not be decoded"
            ) from error
        finally:
            if media.temporary_path:
                Path(media.temporary_path).unlink(missing_ok=True)

    async def _convert_to_wav(self, media: ResolvedMedia) -> ResolvedMedia:
        executable = shutil.which(self._ffmpeg_path)
        if not executable:
            raise AudioConversionError(
                f"FFmpeg is required to convert {media.mime_type}; "
                "configure ffmpeg_path or install FFmpeg"
            )
        input_path = Path(media.local_path) if media.local_path else None
        created_input = False
        if not input_path or not input_path.is_file():
            handle, name = tempfile.mkstemp(
                prefix="lumi-audio-input-",
                suffix=".silk" if media.mime_type == "audio/silk" else ".amr",
                dir=self._temp_directory,
            )
            os.close(handle)
            input_path = Path(name)
            await asyncio.to_thread(input_path.write_bytes, media.data)
            created_input = True
        handle, output_name = tempfile.mkstemp(
            prefix="lumi-audio-", suffix=".wav", dir=self._temp_directory
        )
        os.close(handle)
        output_path = Path(output_name)
        try:
            process = await asyncio.create_subprocess_exec(
                executable,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(input_path),
                str(output_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                _, stderr = await asyncio.wait_for(
                    process.communicate(),
                    timeout=self._conversion_timeout_seconds,
                )
            except TimeoutError as error:
                process.kill()
                await process.wait()
                raise AudioConversionError(
                    "FFmpeg audio conversion timed out"
                ) from error
            if process.returncode != 0:
                detail = stderr.decode("utf-8", errors="replace").strip()[:300]
                raise AudioConversionError(
                    f"FFmpeg could not convert {media.mime_type}: {detail or 'unknown error'}"
                )
            data = await _read_bounded(output_path, self._maximum_bytes)
            return ResolvedMedia(
                data=data,
                mime_type="audio/wav",
                source_url=media.source_url,
                local_path=str(output_path),
                temporary_path=str(output_path),
            )
        except AudioConversionError:
            output_path.unlink(missing_ok=True)
            raise
        except (MediaTooLargeError, UnsupportedMediaError):
            output_path.unlink(missing_ok=True)
            raise
        except OSError as error:
            output_path.unlink(missing_ok=True)
            raise AudioConversionError(
                "FFmpeg audio conversion could not start"
            ) from error
        finally:
            if created_input:
                input_path.unlink(missing_ok=True)
            if media.temporary_path:
                Path(media.temporary_path).unlink(missing_ok=True)


def redact_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        return "<non-http-media-source>"
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def cleanup_temporary_files(paths: list[str]) -> None:
    for item in paths:
        try:
            Path(item).unlink(missing_ok=True)
        except OSError:
            pass


def _first_local_path(reference: MediaReference) -> Path | None:
    for candidate in (reference.path, reference.url, reference.file):
        if not candidate:
            continue
        if candidate.startswith("file://"):
            parsed = urlparse(candidate)
            path_text = unquote(parsed.path)
            if parsed.netloc:
                path_text = f"//{parsed.netloc}{path_text}"
            if os.name == "nt" and path_text.startswith("/") and len(path_text) > 2:
                path_text = path_text[1:]
            path = Path(path_text)
        elif "://" not in candidate:
            path = Path(candidate)
        else:
            continue
        if path.is_file():
            return path.resolve()
    return None


async def _read_bounded(path: Path, maximum_bytes: int) -> bytes:
    size = await asyncio.to_thread(lambda: path.stat().st_size)
    _check_size(size, maximum_bytes, "media")
    return await asyncio.to_thread(path.read_bytes)


def _check_size(size: int, maximum_bytes: int, kind: str) -> None:
    if size <= 0:
        raise UnsupportedMediaError(f"{kind} is empty")
    if size > maximum_bytes:
        raise MediaTooLargeError(f"{kind} exceeds {maximum_bytes} bytes")


def _detect_mime(
    data: bytes,
    declared: str | None,
    name: str | None,
    kind: str,
) -> str:
    declared_type = (declared or "").split(";", 1)[0].strip().lower()
    detected = _magic_mime(data)
    guessed = mimetypes.guess_type(name or "")[0]
    mime_type = detected or declared_type or guessed
    allowed_prefix = "image/" if kind == "image" else "audio/"
    allowed_audio = {"video/webm", "video/mp4", "application/ogg"}
    if not mime_type or (
        not mime_type.startswith(allowed_prefix)
        and not (kind == "audio" and mime_type in allowed_audio)
    ):
        raise UnsupportedMediaError(f"unsupported {kind} MIME type")
    if detected and declared_type and detected != declared_type:
        if kind == "audio":
            # QQ/OneBot record components frequently retain the source MIME
            # after get_record converts it, or claim WAV while returning the
            # original SILK/AMR payload. A recognized audio magic signature is
            # authoritative and still prevents image/arbitrary bytes entering
            # the hearing pipeline.
            return detected
        raise UnsupportedMediaError(f"{kind} MIME type does not match its bytes")
    return mime_type


def _magic_mime(data: bytes) -> str | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "audio/wav"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if data.startswith(b"#!AMR\n"):
        return "audio/amr"
    if data.startswith(b"#!SILK_V3") or data.startswith(b"\x02#!SILK_V3"):
        return "audio/silk"
    if data.startswith(b"ID3") or data[:2] in {
        b"\xff\xfb",
        b"\xff\xf3",
        b"\xff\xf2",
    }:
        return "audio/mpeg"
    if data.startswith(b"\x1aE\xdf\xa3"):
        return "audio/webm"
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "audio/mp4"
    return None
