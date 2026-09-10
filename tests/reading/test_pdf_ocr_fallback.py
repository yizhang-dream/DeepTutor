from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import deeptutor.reading.extract as extract_mod
from deeptutor.reading.extract import _ocr_block_text, _ocr_pdf_units, extract_material
from deeptutor.reading.models import ReadingError
from deeptutor.services.parsing.types import ParsedDocument


def _blank_pdf(tmp_path: Path, *, pages: int = 2, name: str = "scan.pdf") -> Path:
    """An image-only PDF: real pages, zero text layer."""
    import pymupdf

    path = tmp_path / name
    with pymupdf.open() as doc:
        for _ in range(pages):
            doc.new_page()
        doc.save(path)
    return path


class _FakeParseService:
    def __init__(self, result: ParsedDocument) -> None:
        self._result = result

    def parse(self, source_path, *, engine=None, on_output=None):
        assert engine == "mineru"
        return self._result


def _patch_parse(monkeypatch: pytest.MonkeyPatch, service: Any) -> None:
    monkeypatch.setattr(
        "deeptutor.services.parsing.get_parse_service", lambda: service
    )


def _patch_fallback_enabled(monkeypatch: pytest.MonkeyPatch, enabled: bool) -> None:
    import deeptutor.services.config.runtime_settings as rt

    monkeypatch.setattr(
        rt, "load_document_parsing_settings", lambda: {"ocr_fallback": enabled}
    )


def test_ocr_units_map_blocks_back_to_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fallback_enabled(monkeypatch, True)
    parsed = ParsedDocument(
        markdown="full text",
        blocks=[
            {"type": "text", "text": "page one", "page_idx": 0},
            {"type": "text", "text": "page two", "page_idx": 1},
        ],
        engine="mineru",
    )
    _patch_parse(monkeypatch, _FakeParseService(parsed))

    units = _ocr_pdf_units(_blank_pdf(tmp_path), page_count=2)

    assert units == ("page one", "page two")


def test_ocr_units_none_when_fallback_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fallback_enabled(monkeypatch, False)
    assert _ocr_pdf_units(_blank_pdf(tmp_path), page_count=2) is None


def test_ocr_units_none_when_ocr_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fallback_enabled(monkeypatch, True)

    class _Boom:
        def parse(self, *args, **kwargs):
            raise RuntimeError("models missing")

    _patch_parse(monkeypatch, _Boom())
    assert _ocr_pdf_units(_blank_pdf(tmp_path), page_count=2) is None


def test_extract_material_raises_standard_error_when_fallback_cannot_help(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fallback_enabled(monkeypatch, False)
    with pytest.raises(ReadingError, match="scanned document needs OCR"):
        extract_material(_blank_pdf(tmp_path))


def test_extract_material_ocr_fallback_produces_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_fallback_enabled(monkeypatch, True)
    parsed = ParsedDocument(
        markdown="full text",
        blocks=[
            {"type": "text", "text": "第一章", "page_idx": 0},
            {"type": "text", "text": "第二章", "page_idx": 1},
        ],
        engine="mineru",
    )
    _patch_parse(monkeypatch, _FakeParseService(parsed))

    extraction = extract_material(_blank_pdf(tmp_path))

    assert extraction.extractor == "mineru-ocr"
    assert extraction.units == ("第一章", "第二章")
    assert extraction.render_mode == "pdf"
    assert extraction.has_raw_view is True


def test_ocr_block_text_flattens_known_fields() -> None:
    block = {
        "type": "image",
        "img_caption": ["图 1", " "],
        "img_footnote": ["注：来自原书"],
        "page_idx": 3,
    }
    assert _ocr_block_text(block) == "图 1\n注：来自原书"
