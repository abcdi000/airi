from __future__ import annotations

import os
import re
import unittest
from pathlib import Path


class AstrBotSourceContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        source_root = os.environ.get("ASTRBOT_SOURCE_ROOT")
        if not source_root:
            raise unittest.SkipTest("ASTRBOT_SOURCE_ROOT is not configured")
        cls.root = Path(source_root)

    def test_checked_version_is_astrbot_4_26_7(self) -> None:
        project = (self.root / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('version = "4.26.7"', project)

    def test_message_components_expose_required_media_fields(self) -> None:
        source = (self.root / "astrbot/core/message/components.py").read_text(
            encoding="utf-8"
        )
        for class_name in ("Plain", "Image", "Record", "At", "Reply"):
            self.assertRegex(source, rf"class {class_name}\(")
        self.assertRegex(source, r"class Plain\(.*?\):\s+type:.*?\s+text: str")
        for field in ("file:", "url:", "path:"):
            self.assertIn(field, source)

    def test_current_pipeline_uses_call_llm_true_to_suppress_default_agent(
        self,
    ) -> None:
        event_source = (
            self.root / "astrbot/core/platform/astr_message_event.py"
        ).read_text(encoding="utf-8")
        stage_source = (
            self.root / "astrbot/core/pipeline/process_stage/stage.py"
        ).read_text(encoding="utf-8")
        self.assertIn("self.call_llm = call_llm", event_source)
        self.assertTrue(
            re.search(r"\band\s+not\s+event\.call_llm", stage_source),
            "AstrBot pipeline suppression semantics changed",
        )

    def test_plugin_lifecycle_and_priority_arguments_are_still_public(self) -> None:
        star_source = (self.root / "astrbot/core/star/base.py").read_text(
            encoding="utf-8"
        )
        register_source = (
            self.root / "astrbot/core/star/register/star_handler.py"
        ).read_text(encoding="utf-8")
        metadata_source = (self.root / "astrbot/core/star/star_handler.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("async def terminate(", star_source)
        self.assertIn("**kwargs", register_source)
        self.assertIn('"priority"', metadata_source)
