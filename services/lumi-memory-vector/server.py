from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

import numpy as np

DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
DEFAULT_BATCH_SIZE = 32

_MODEL = None
_MODEL_ID = ""
_DEVICE = "unknown"


def _emit_progress(payload: dict[str, Any]) -> None:
    print(f"[lumi-memory-vector-progress] {json.dumps(payload, ensure_ascii=False)}", file=sys.stderr, flush=True)


def _human_bytes(value: int | float | None) -> str:
    if value is None:
        return "unknown"
    number = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if number < 1024 or unit == "TB":
            return f"{number:.1f}{unit}" if unit != "B" else f"{int(number)}B"
        number /= 1024
    return f"{number:.1f}TB"


def _model_cache_dir(model_id: str) -> Path:
    try:
        from huggingface_hub.constants import HF_HUB_CACHE

        root = Path(HF_HUB_CACHE)
    except Exception:
        root = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface") / "hub"
    return root / f"models--{model_id.replace('/', '--')}"


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            continue
    return total


def _expected_model_size(model_id: str) -> int | None:
    configured = os.environ.get("LUMI_MEMORY_VECTOR_MODEL_SIZE_BYTES")
    if configured:
        try:
            return int(configured)
        except ValueError:
            pass
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(model_id, files_metadata=True)
        sizes = [getattr(sibling, "size", None) for sibling in getattr(info, "siblings", [])]
        total = sum(size for size in sizes if isinstance(size, int) and size > 0)
        return total or None
    except Exception as error:
        _emit_progress({
            "phase": "downloading",
            "message": f"正在下载 {model_id}: 无法预估总大小 ({error})",
        })
        return None


def _start_download_monitor(model_id: str, total_bytes: int | None):
    stop = threading.Event()
    cache_dir = _model_cache_dir(model_id)

    def run() -> None:
        previous_size = _dir_size(cache_dir)
        previous_at = time.monotonic()
        while not stop.wait(2.0):
            current_size = _dir_size(cache_dir)
            current_at = time.monotonic()
            elapsed = max(0.001, current_at - previous_at)
            speed = max(0.0, (current_size - previous_size) / elapsed)
            percent = None
            if total_bytes and total_bytes > 0:
                percent = min(100.0, (current_size / total_bytes) * 100)
            message = f"正在下载 {model_id}: {_human_bytes(current_size)}"
            if total_bytes:
                message += f" / {_human_bytes(total_bytes)}"
            message += f" · {_human_bytes(speed)}/s"
            _emit_progress({
                "phase": "downloading",
                "model": model_id,
                "downloadedBytes": current_size,
                "totalBytes": total_bytes,
                "speedBytesPerSecond": speed,
                "percent": percent,
                "message": message,
            })
            previous_size = current_size
            previous_at = current_at

    thread = threading.Thread(target=run, name="lumi-memory-vector-download-monitor", daemon=True)
    thread.start()
    return stop, thread


def _setup_logging() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    logging.basicConfig(
        level=logging.INFO,
        format="[lumi-memory-vector] %(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )


def _torch_diagnostics() -> dict[str, Any]:
    try:
        import torch

        cuda_available = bool(torch.cuda.is_available())
        return {
            "torchVersion": getattr(torch, "__version__", "unknown"),
            "torchCuda": getattr(torch.version, "cuda", None),
            "cudaAvailable": cuda_available,
            "cudaDeviceCount": int(torch.cuda.device_count()),
            "cudaDeviceName": torch.cuda.get_device_name(0) if cuda_available else "",
        }
    except Exception as error:
        return {
            "torchError": str(error),
            "cudaAvailable": False,
        }


def _resolve_device(requested: str | None) -> str | None:
    diagnostics = _torch_diagnostics()
    _emit_progress({
        "phase": "device_check",
        "requestedDevice": requested or "auto",
        "message": (
            f"设备检测: torch={diagnostics.get('torchVersion', 'unknown')}, "
            f"torch_cuda={diagnostics.get('torchCuda') or 'none'}, "
            f"cuda_available={diagnostics.get('cudaAvailable')}"
        ),
        **diagnostics,
    })

    if requested and requested != "auto":
        if requested == "cuda" and not diagnostics.get("cudaAvailable"):
            raise RuntimeError(
                "Requested CUDA for Lumi memory vectors, but torch.cuda.is_available() is false. "
                f"torch={diagnostics.get('torchVersion', 'unknown')} "
                f"torch_cuda={diagnostics.get('torchCuda') or 'none'}"
            )
        return requested

    if diagnostics.get("cudaAvailable"):
        return "cuda"
    try:
        import torch

        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _load_model(model_id: str, device: str | None = None, local_files_only: bool = False):
    global _MODEL, _MODEL_ID, _DEVICE
    if _MODEL is not None and _MODEL_ID == model_id:
        return _MODEL

    from huggingface_hub import snapshot_download
    from sentence_transformers import SentenceTransformer

    resolved_device = _resolve_device(device)
    logging.info("checking/downloading embedding model=%s local_files_only=%s", model_id, local_files_only)
    _emit_progress({
        "phase": "downloading" if not local_files_only else "checking_cache",
        "model": model_id,
        "device": resolved_device,
        "message": f"正在检查/下载 {model_id}",
    })
    total_bytes = None if local_files_only else _expected_model_size(model_id)
    monitor = None if local_files_only else _start_download_monitor(model_id, total_bytes)
    try:
        snapshot_path = snapshot_download(
            repo_id=model_id,
            local_files_only=local_files_only,
        )
    finally:
        if monitor is not None:
            stop, thread = monitor
            stop.set()
            thread.join(timeout=1.0)
    _emit_progress({
        "phase": "loading_model",
        "model": model_id,
        "device": resolved_device,
        "message": f"模型文件已就绪，正在加载到 {resolved_device}: {snapshot_path}",
    })
    logging.info("loading embedding model=%s device=%s local_files_only=%s", model_id, resolved_device, local_files_only)
    _MODEL = SentenceTransformer(
        model_id,
        device=resolved_device,
        local_files_only=local_files_only,
    )
    _MODEL_ID = model_id
    _DEVICE = str(resolved_device or "auto")
    logging.info("embedding model ready model=%s device=%s", _MODEL_ID, _DEVICE)
    _emit_progress({
        "phase": "ready",
        "model": model_id,
        "device": _DEVICE,
        "percent": 100,
        "message": f"向量模型已就绪: {model_id} ({_DEVICE})",
    })
    return _MODEL


def _embed_texts(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = str(payload.get("model") or DEFAULT_MODEL)
    texts = payload.get("texts")
    if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
        raise ValueError("texts must be a string array")
    batch_size = int(payload.get("batchSize") or DEFAULT_BATCH_SIZE)
    local_files_only = bool(payload.get("localFilesOnly") or False)
    device = payload.get("device")
    model = _load_model(model_id, str(device) if device else None, local_files_only)
    vectors = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    vectors = np.asarray(vectors, dtype=np.float32)
    return {
        "model": model_id,
        "device": _DEVICE,
        "dimensions": int(vectors.shape[1]) if len(vectors.shape) > 1 else int(vectors.shape[0]),
        "vectors": vectors.tolist(),
    }


def _health(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = str(payload.get("model") or DEFAULT_MODEL)
    return {
        "ok": True,
        "model": _MODEL_ID or model_id,
        "device": _DEVICE,
        "loaded": _MODEL is not None,
        "pid": os.getpid(),
        "torch": _torch_diagnostics(),
    }


def _handle(request: dict[str, Any]) -> dict[str, Any]:
    method = request.get("method")
    payload = request.get("params") if isinstance(request.get("params"), dict) else {}
    if method == "health":
        return _health(payload)
    if method == "embed":
        return _embed_texts(payload)
    raise ValueError(f"unknown method: {method}")


def main() -> None:
    _setup_logging()
    logging.info("worker started pid=%s", os.getpid())
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            result = _handle(request)
            response = {
                "id": request.get("id"),
                "ok": True,
                "result": result,
            }
        except Exception as error:
            logging.exception("request failed")
            response = {
                "id": request.get("id") if isinstance(locals().get("request"), dict) else None,
                "ok": False,
                "error": str(error),
            }
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
