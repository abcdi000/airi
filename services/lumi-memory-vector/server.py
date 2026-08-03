from __future__ import annotations

import json
import logging
import os
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TQDM_DISABLE", "1")

import numpy as np

DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
DEFAULT_BATCH_SIZE = 32
ANN_INDEX_FORMAT = "lumi-usearch-index:v1"
ANN_CONNECTIVITY = 16
ANN_EXPANSION_ADD = 128
ANN_EXPANSION_SEARCH = 64

_MODEL = None
_MODEL_ID = ""
_DEVICE = "unknown"


@dataclass
class _AnnState:
    path: Path
    model: str
    dimensions: int
    sequence: int
    index: Any


_ANN_INDEXES: dict[str, _AnnState] = {}
_ANN_REBUILDS: dict[str, _AnnState] = {}


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


def _ann_path(payload: dict[str, Any]) -> Path:
    raw = payload.get("path")
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("ANN path must be a non-empty string")
    path = Path(raw).expanduser().resolve()
    if path.suffix != ".usearch":
        raise ValueError("ANN path must end with .usearch")
    return path


def _ann_manifest_path(path: Path) -> Path:
    return Path(f"{path}.json")


def _ann_model(payload: dict[str, Any]) -> str:
    model = payload.get("model")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("ANN model must be a non-empty string")
    return model.strip()


def _ann_dimensions(payload: dict[str, Any]) -> int:
    dimensions = payload.get("dimensions")
    if not isinstance(dimensions, int) or isinstance(dimensions, bool) or dimensions <= 0 or dimensions > 65536:
        raise ValueError("ANN dimensions must be a positive integer")
    return dimensions


def _ann_sequence(payload: dict[str, Any]) -> int:
    sequence = payload.get("sequence")
    if not isinstance(sequence, int) or isinstance(sequence, bool) or sequence < 0:
        raise ValueError("ANN sequence must be a non-negative integer")
    return sequence


def _ann_key(value: Any) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0 or value > 0x1FFFFFFFFFFFFF:
        raise ValueError("ANN keys must be positive safe integers")
    return value


def _new_ann_index(dimensions: int):
    from usearch.index import Index

    return Index(
        ndim=dimensions,
        metric="cos",
        dtype="f32",
        connectivity=ANN_CONNECTIVITY,
        expansion_add=ANN_EXPANSION_ADD,
        expansion_search=ANN_EXPANSION_SEARCH,
        enable_key_lookups=True,
    )


def _ann_status(state: _AnnState, *, ready: bool = True, reason: str | None = None) -> dict[str, Any]:
    return {
        "ready": ready,
        "needsRebuild": not ready,
        "model": state.model,
        "dimensions": state.dimensions,
        "sequence": state.sequence,
        "count": int(state.index.size),
        "reason": reason,
    }


def _missing_ann_status(model: str, dimensions: int, reason: str) -> dict[str, Any]:
    return {
        "ready": False,
        "needsRebuild": True,
        "model": model,
        "dimensions": dimensions,
        "sequence": 0,
        "count": 0,
        "reason": reason,
    }


def _load_ann(path: Path, model: str, dimensions: int) -> _AnnState | None:
    cache_key = str(path)
    cached = _ANN_INDEXES.get(cache_key)
    if cached is not None:
        if cached.model == model and cached.dimensions == dimensions:
            return cached
        _ANN_INDEXES.pop(cache_key, None)

    manifest_path = _ann_manifest_path(path)
    if not path.exists() or not manifest_path.exists():
        return None

    from usearch.index import Index

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != ANN_INDEX_FORMAT:
        raise ValueError("ANN manifest format is unsupported")
    if manifest.get("engine") != "usearch" or manifest.get("engineVersion") != _usearch_version():
        raise ValueError("ANN manifest engine version is incompatible")
    if manifest.get("model") != model or manifest.get("dimensions") != dimensions:
        raise ValueError("ANN manifest does not match the configured model or dimensions")
    sequence = manifest.get("sequence")
    count = manifest.get("count")
    if not isinstance(sequence, int) or sequence < 0 or not isinstance(count, int) or count < 0:
        raise ValueError("ANN manifest counters are invalid")

    index = Index.restore(str(path), view=False)
    if index is None or int(index.ndim) != dimensions or int(index.size) != count:
        raise ValueError("ANN index does not match its manifest")
    state = _AnnState(path=path, model=model, dimensions=dimensions, sequence=sequence, index=index)
    _ANN_INDEXES[cache_key] = state
    return state


def _save_ann(state: _AnnState) -> None:
    state.path.parent.mkdir(parents=True, exist_ok=True)
    suffix = f".tmp-{os.getpid()}-{uuid.uuid4().hex}"
    temporary_index = Path(f"{state.path}{suffix}")
    manifest_path = _ann_manifest_path(state.path)
    temporary_manifest = Path(f"{manifest_path}{suffix}")
    manifest = {
        "format": ANN_INDEX_FORMAT,
        "engine": "usearch",
        "engineVersion": _usearch_version(),
        "model": state.model,
        "dimensions": state.dimensions,
        "sequence": state.sequence,
        "count": int(state.index.size),
        "updatedAt": int(time.time() * 1000),
    }
    try:
        state.index.save(str(temporary_index))
        # NOTICE:
        # Windows rejects fsync on a read-only descriptor even though USearch
        # has already closed the saved index. Reopen read/write only to flush it.
        # Source/context: Python's Windows file descriptor rules in _save_ann.
        # Removal condition: USearch exposes a durable atomic-save operation.
        with temporary_index.open("r+b") as index_file:
            os.fsync(index_file.fileno())
        with temporary_manifest.open("w", encoding="utf-8", newline="\n") as manifest_file:
            json.dump(manifest, manifest_file, ensure_ascii=False, indent=2)
            manifest_file.write("\n")
            manifest_file.flush()
            os.fsync(manifest_file.fileno())
        os.replace(temporary_index, state.path)
        os.replace(temporary_manifest, manifest_path)
    finally:
        temporary_index.unlink(missing_ok=True)
        temporary_manifest.unlink(missing_ok=True)


def _usearch_version() -> str:
    import usearch

    return str(getattr(usearch, "__version__", "unknown"))


def _ann_open(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    model = _ann_model(payload)
    dimensions = _ann_dimensions(payload)
    try:
        state = _load_ann(path, model, dimensions)
        if state is None:
            return _missing_ann_status(model, dimensions, "missing_index")
        return _ann_status(state)
    except Exception as error:
        _ANN_INDEXES.pop(str(path), None)
        logging.warning("ANN index requires rebuild path=%s reason=%s", path.name, error)
        return _missing_ann_status(model, dimensions, "corrupt_or_incompatible_index")


def _ann_rebuild_begin(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    model = _ann_model(payload)
    dimensions = _ann_dimensions(payload)
    state = _AnnState(
        path=path,
        model=model,
        dimensions=dimensions,
        sequence=0,
        index=_new_ann_index(dimensions),
    )
    _ANN_REBUILDS[str(path)] = state
    return _ann_status(state, ready=False, reason="rebuild_in_progress")


def _ann_add_records(state: _AnnState, payload: dict[str, Any]) -> int:
    raw_keys = payload.get("keys")
    raw_vectors = payload.get("vectors")
    if not isinstance(raw_keys, list) or not isinstance(raw_vectors, list) or len(raw_keys) != len(raw_vectors):
        raise ValueError("ANN keys and vectors must be equal-length arrays")
    if len(raw_keys) > 2000:
        raise ValueError("ANN batches may contain at most 2000 vectors")
    if not raw_keys:
        return 0

    keys = np.asarray([_ann_key(value) for value in raw_keys], dtype=np.uint64)
    vectors = np.asarray(raw_vectors, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape != (len(keys), state.dimensions) or not np.isfinite(vectors).all():
        raise ValueError("ANN vectors are invalid or have inconsistent dimensions")
    for key in keys:
        numeric_key = int(key)
        if state.index.contains(numeric_key):
            state.index.remove(numeric_key)
    state.index.add(keys, vectors, copy=True)
    return len(keys)


def _ann_rebuild_add(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    state = _ANN_REBUILDS.get(str(path))
    if state is None:
        raise ValueError("ANN rebuild has not been started")
    added = _ann_add_records(state, payload)
    return {**_ann_status(state, ready=False, reason="rebuild_in_progress"), "added": added}


def _ann_rebuild_commit(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    state = _ANN_REBUILDS.get(str(path))
    if state is None:
        raise ValueError("ANN rebuild has not been started")
    state.sequence = _ann_sequence(payload)
    _save_ann(state)
    _ANN_REBUILDS.pop(str(path), None)
    _ANN_INDEXES[str(path)] = state
    return _ann_status(state)


def _ann_rebuild_abort(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    removed = _ANN_REBUILDS.pop(str(path), None) is not None
    return {"aborted": removed}


def _ann_apply(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    model = _ann_model(payload)
    dimensions = _ann_dimensions(payload)
    state = _load_ann(path, model, dimensions)
    if state is None:
        raise ValueError("ANN index is missing and must be rebuilt")

    raw_removals = payload.get("removeKeys")
    if not isinstance(raw_removals, list) or len(raw_removals) > 10000:
        raise ValueError("ANN removeKeys must be a bounded array")
    removed = 0
    for raw_key in raw_removals:
        key = _ann_key(raw_key)
        if state.index.contains(key):
            state.index.remove(key)
            removed += 1
    added = _ann_add_records(state, payload)
    state.sequence = _ann_sequence(payload)
    try:
        _save_ann(state)
    except Exception:
        _ANN_INDEXES.pop(str(path), None)
        raise
    return {**_ann_status(state), "added": added, "removed": removed}


def _ann_search(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    model = _ann_model(payload)
    dimensions = _ann_dimensions(payload)
    state = _load_ann(path, model, dimensions)
    if state is None:
        raise ValueError("ANN index is missing and must be rebuilt")
    count = payload.get("count", 80)
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0 or count > 2000:
        raise ValueError("ANN search count must be between 1 and 2000")
    vector = np.asarray(payload.get("vector"), dtype=np.float32)
    if vector.shape != (dimensions,) or not np.isfinite(vector).all():
        raise ValueError("ANN query vector is invalid")
    matches = state.index.search(vector, count=min(count, max(1, int(state.index.size))), exact=False)
    keys = [int(value) for value in matches.keys]
    distances = [float(value) for value in matches.distances]
    scores = [max(-1.0, min(1.0, 1.0 - distance)) for distance in distances]
    return {
        **_ann_status(state),
        "keys": keys,
        "scores": scores,
    }


def _ann_close(payload: dict[str, Any]) -> dict[str, Any]:
    path = _ann_path(payload)
    _ANN_REBUILDS.pop(str(path), None)
    closed = _ANN_INDEXES.pop(str(path), None) is not None
    return {"closed": closed}


def _health(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = str(payload.get("model") or DEFAULT_MODEL)
    return {
        "ok": True,
        "model": _MODEL_ID or model_id,
        "device": _DEVICE,
        "loaded": _MODEL is not None,
        "pid": os.getpid(),
        "torch": _torch_diagnostics(),
        "ann": {
            "engine": "usearch",
            "version": _usearch_version(),
            "openIndexes": len(_ANN_INDEXES),
        },
    }


def _handle(request: dict[str, Any]) -> dict[str, Any]:
    method = request.get("method")
    payload = request.get("params") if isinstance(request.get("params"), dict) else {}
    if method == "health":
        return _health(payload)
    if method == "embed":
        return _embed_texts(payload)
    if method == "ann_open":
        return _ann_open(payload)
    if method == "ann_rebuild_begin":
        return _ann_rebuild_begin(payload)
    if method == "ann_rebuild_add":
        return _ann_rebuild_add(payload)
    if method == "ann_rebuild_commit":
        return _ann_rebuild_commit(payload)
    if method == "ann_rebuild_abort":
        return _ann_rebuild_abort(payload)
    if method == "ann_apply":
        return _ann_apply(payload)
    if method == "ann_search":
        return _ann_search(payload)
    if method == "ann_close":
        return _ann_close(payload)
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
