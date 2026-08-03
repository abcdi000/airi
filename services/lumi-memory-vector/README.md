# Lumi Memory Vector Service

This is AIRI's local semantic memory embedding worker for Lumi.

It intentionally does not own Lumi's memory database. Electron and Lumi Server
keep memories, vectors, provenance, lifecycle, and ACL metadata in SQLite. This
Python worker keeps the embedding model warm and maintains a disposable USearch
HNSW projection containing only numeric ANN keys and normalized vectors.

Default model:

```text
BAAI/bge-small-zh-v1.5
```

Install dependencies in the AIRI conda environment:

```powershell
conda run -n airi python -m pip install -r services\lumi-memory-vector\requirements.txt
```

Optional environment override:

```powershell
$env:LUMI_MEMORY_VECTOR_PYTHON="D:\anaconda3\envs\airi\python.exe"
```

The worker is started by the Electron main process on first vector use and stays
alive until AIRI exits.

USearch 2.26.0 maintains the disposable persistent HNSW index. Rebuilds use a
temporary index and atomic replacement; incremental upserts and removals are
persisted with a model/dimension/revision manifest. Missing, stale, or corrupt
indexes are rebuilt from SQLite. Every search candidate is resolved back through
SQLite before it can enter Lumi's cognitive context.

Run the worker regression tests with:

```powershell
python -m unittest services/lumi-memory-vector/test_server.py
```

## Windows packaged runtime

Lumi's Windows installer uses a private Python runtime so semantic memory works on
machines without Python, conda, or the embedding dependencies installed. The
default packaged `torch` build is CUDA-enabled so Lumi can use NVIDIA GPUs for
semantic vector search. At runtime, the worker still falls back to CPU when CUDA
is unavailable.

Prepare it with:

```powershell
pnpm -F @proj-airi/stage-tamagotchi run build:python-runtime
```

Windows packaging commands run this step automatically. The script creates:

```text
apps/stage-tamagotchi/resources/python
apps/stage-tamagotchi/resources/vector-model-cache
```

These generated directories are intentionally ignored by git and copied into the
installer via `electron-builder.extraResources`.

Useful overrides:

```powershell
$env:LUMI_SKIP_VECTOR_PYTHON_RUNTIME="1"       # skip runtime preparation
$env:LUMI_FORCE_VECTOR_PYTHON_RUNTIME="1"      # rebuild the runtime
$env:LUMI_VECTOR_RUNTIME_SKIP_MODEL="1"        # install Python/deps only
$env:LUMI_VECTOR_RUNTIME_SKIP_TORCH="1"        # skip the explicit torch wheel step
$env:LUMI_VECTOR_TORCH_VARIANT="cuda"          # default: cuda
$env:LUMI_VECTOR_TORCH_CUDA_FLAVOR="cu130"     # default CUDA wheel flavor
$env:LUMI_VECTOR_TORCH_VARIANT="cpu"           # build a smaller CPU-only runtime
$env:LUMI_VECTOR_TORCH_INDEX_URL="https://download.pytorch.org/whl/cu126"
$env:LUMI_VECTOR_PIP_EXTRA_ARGS="-i https://pypi.tuna.tsinghua.edu.cn/simple"
```

The build step installs `torch` first from the selected PyTorch wheel index, then
installs the rest of `requirements.txt` from the normal Python package index.
This keeps packaged Lumi independent from conda and system Python while still
allowing a GPU-first Windows installer.
