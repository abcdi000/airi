# Lumi Memory Vector Service

This is AIRI's local semantic memory embedding worker for Lumi.

It intentionally does not own Lumi's memory database. Electron keeps memories and
vectors in SQLite, while this Python worker only keeps the embedding model warm
and converts text into normalized vectors.

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
