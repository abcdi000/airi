from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SERVER_PATH = Path(__file__).with_name("server.py")
SERVER_SPEC = importlib.util.spec_from_file_location("lumi_memory_vector_server", SERVER_PATH)
if SERVER_SPEC is None or SERVER_SPEC.loader is None:
    raise RuntimeError(f"Unable to load vector worker from {SERVER_PATH}")
server = importlib.util.module_from_spec(SERVER_SPEC)
sys.modules[SERVER_SPEC.name] = server
SERVER_SPEC.loader.exec_module(server)


class AnnWorkerTest(unittest.TestCase):
    def setUp(self) -> None:
        server._ANN_INDEXES.clear()
        server._ANN_REBUILDS.clear()
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.index_path = Path(self.temporary_directory.name) / "memory.usearch"
        self.base = {
            "path": str(self.index_path),
            "model": "test-model",
            "dimensions": 3,
        }

    def tearDown(self) -> None:
        server._ANN_INDEXES.clear()
        server._ANN_REBUILDS.clear()
        self.temporary_directory.cleanup()

    def test_persists_updates_deletes_and_reopens(self) -> None:
        missing = server._handle({"method": "ann_open", "params": self.base})
        self.assertTrue(missing["needsRebuild"])

        server._handle({"method": "ann_rebuild_begin", "params": self.base})
        server._handle({
            "method": "ann_rebuild_add",
            "params": {
                **self.base,
                "keys": [1, 2],
                "vectors": [[1, 0, 0], [0, 1, 0]],
            },
        })
        committed = server._handle({
            "method": "ann_rebuild_commit",
            "params": {**self.base, "sequence": 2},
        })
        self.assertEqual(committed["count"], 2)
        self.assertEqual(committed["sequence"], 2)
        manifest = json.loads(Path(f"{self.index_path}.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["engine"], "usearch")
        self.assertEqual(manifest["engineVersion"], "2.26.0")

        health = server._handle({"method": "health", "params": {"model": "test-model"}})
        self.assertEqual(health["ann"]["engine"], "usearch")
        self.assertEqual(health["ann"]["version"], "2.26.0")

        first = server._handle({
            "method": "ann_search",
            "params": {**self.base, "vector": [1, 0, 0], "count": 5},
        })
        self.assertEqual(first["keys"][0], 1)

        applied = server._handle({
            "method": "ann_apply",
            "params": {
                **self.base,
                "keys": [3],
                "vectors": [[0, 0, 1]],
                "removeKeys": [1],
                "sequence": 4,
            },
        })
        self.assertEqual(applied["count"], 2)
        self.assertEqual(applied["removed"], 1)

        second = server._handle({
            "method": "ann_search",
            "params": {**self.base, "vector": [0, 0, 1], "count": 5},
        })
        self.assertEqual(second["keys"][0], 3)
        self.assertNotIn(1, second["keys"])

        server._handle({"method": "ann_close", "params": self.base})
        reopened = server._handle({"method": "ann_open", "params": self.base})
        self.assertTrue(reopened["ready"])
        self.assertEqual(reopened["sequence"], 4)
        self.assertEqual(reopened["count"], 2)

    def test_marks_a_corrupt_index_for_rebuild(self) -> None:
        server._handle({"method": "ann_rebuild_begin", "params": self.base})
        server._handle({
            "method": "ann_rebuild_add",
            "params": {**self.base, "keys": [1], "vectors": [[1, 0, 0]]},
        })
        server._handle({
            "method": "ann_rebuild_commit",
            "params": {**self.base, "sequence": 1},
        })
        server._handle({"method": "ann_close", "params": self.base})

        self.index_path.write_bytes(b"corrupt-index")
        status = server._handle({"method": "ann_open", "params": self.base})

        self.assertTrue(status["needsRebuild"])
        self.assertEqual(status["reason"], "corrupt_or_incompatible_index")

    def test_rebuilds_an_index_created_by_an_incompatible_engine_version(self) -> None:
        server._handle({"method": "ann_rebuild_begin", "params": self.base})
        server._handle({
            "method": "ann_rebuild_add",
            "params": {**self.base, "keys": [1], "vectors": [[1, 0, 0]]},
        })
        server._handle({
            "method": "ann_rebuild_commit",
            "params": {**self.base, "sequence": 1},
        })
        server._handle({"method": "ann_close", "params": self.base})

        manifest_path = Path(f"{self.index_path}.json")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["engineVersion"] = "0.0.0"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        status = server._handle({"method": "ann_open", "params": self.base})

        self.assertTrue(status["needsRebuild"])
        self.assertEqual(status["reason"], "corrupt_or_incompatible_index")


if __name__ == "__main__":
    unittest.main()
