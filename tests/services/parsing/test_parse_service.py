from __future__ import annotations

from pathlib import Path

import pytest

from deeptutor.services.parsing import base, signature
import deeptutor.services.parsing.service as svc_mod
from deeptutor.services.parsing.service import ParseService
from deeptutor.services.parsing.types import ParserError


class _FakeParser:
    name = "fake"
    needs_local_models = False

    def __init__(self, *, ready: bool = True, sig: str = "v1", calls: list | None = None) -> None:
        self._ready = ready
        self._sig = sig
        self.calls = calls if calls is not None else []

    @classmethod
    def is_available(cls) -> bool:
        return True

    def resolve_config(self):
        return {}

    def supported_formats(self):
        return frozenset({".pdf"})

    def signature(self, _config):
        return signature.ParserSignature.build("fake", "1", {"v": self._sig})

    def is_ready(self, _config):
        return base.ReadinessReport(ready=self._ready, reason="gate", message="not ready")

    def parse(self, source_path: Path, workdir: Path, *, config, on_output=None) -> None:
        self.calls.append(source_path)
        (workdir / f"{source_path.stem}.md").write_text("# md", encoding="utf-8")


def _use(monkeypatch, parser) -> None:
    monkeypatch.setattr(svc_mod, "get_parser", lambda name: parser)


def _pdf(tmp_path: Path, data: bytes = b"%PDF data", name: str = "x.pdf") -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def test_cache_hit_skips_engine(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parser = _FakeParser()
    _use(monkeypatch, parser)
    pdf = _pdf(tmp_path)
    service = ParseService(cache_root=tmp_path / "cache")

    first = service.parse(pdf, engine="fake")
    second = service.parse(pdf, engine="fake")

    assert len(parser.calls) == 1  # engine ran once; second call hit cache
    assert first.markdown == "# md"
    assert first.blocks is None
    assert first.workdir == second.workdir


def test_signature_change_busts_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = _pdf(tmp_path)
    service = ParseService(cache_root=tmp_path / "cache")

    p1 = _FakeParser(sig="v1")
    _use(monkeypatch, p1)
    service.parse(pdf, engine="fake")

    p2 = _FakeParser(sig="v2")
    _use(monkeypatch, p2)
    service.parse(pdf, engine="fake")

    assert len(p1.calls) == 1 and len(p2.calls) == 1  # different signature → re-parse


def test_same_bytes_different_name_share_cache(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parser = _FakeParser()
    _use(monkeypatch, parser)
    service = ParseService(cache_root=tmp_path / "cache")

    service.parse(_pdf(tmp_path, b"identical", "first.pdf"), engine="fake")
    service.parse(_pdf(tmp_path, b"identical", "second.pdf"), engine="fake")
    assert len(parser.calls) == 1


def test_not_ready_raises_before_parse(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parser = _FakeParser(ready=False)
    _use(monkeypatch, parser)
    service = ParseService(cache_root=tmp_path / "cache")
    with pytest.raises(ParserError, match="not ready"):
        service.parse(_pdf(tmp_path), engine="fake")
    assert parser.calls == []


def test_unsupported_format_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parser = _FakeParser()
    _use(monkeypatch, parser)
    service = ParseService(cache_root=tmp_path / "cache")
    with pytest.raises(ParserError, match="support"):
        service.parse(_pdf(tmp_path, b"data", "notes.txt"), engine="fake")


def test_supports_is_a_side_effect_free_suffix_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parser = _FakeParser()
    _use(monkeypatch, parser)
    service = ParseService(cache_root=tmp_path / "cache")

    assert service.supports(tmp_path / "missing.pdf", engine="fake") is True
    assert service.supports(tmp_path / "missing.png", engine="fake") is False
    assert parser.calls == []


def test_supports_compound_suffixes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    parser = _FakeParser()
    parser.supported_formats = lambda: frozenset({".tar.gz", ".dclg.xml"})
    _use(monkeypatch, parser)
    service = ParseService(cache_root=tmp_path / "cache")

    assert service.supports(tmp_path / "missing.TAR.GZ", engine="fake") is True
    assert service.supports(tmp_path / "missing.DCLG.XML", engine="fake") is True
    assert service.supports(tmp_path / "missing.gz", engine="fake") is False


def test_empty_supported_formats_delegates_to_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parser = _FakeParser()
    parser.supported_formats = lambda: frozenset()
    _use(monkeypatch, parser)
    service = ParseService(cache_root=tmp_path / "cache")

    assert service.supports(tmp_path / "custom.vendor-format", engine="fake") is True


def test_missing_file_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _use(monkeypatch, _FakeParser())
    service = ParseService(cache_root=tmp_path / "cache")
    with pytest.raises(ParserError):
        service.parse(tmp_path / "ghost.pdf", engine="fake")


# ---------------------------------------------------------------------------
# Empty-result → MinerU OCR fallback
# ---------------------------------------------------------------------------


class _EmptyParser(_FakeParser):
    """An engine that runs but extracts nothing (scanned PDF, no text layer)."""

    def parse(self, source_path: Path, workdir: Path, *, config, on_output=None) -> None:
        self.calls.append(source_path)
        (workdir / f"{source_path.stem}.md").write_text("", encoding="utf-8")


class _OcrParser(_FakeParser):
    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.name = "mineru"

    def signature(self, _config):
        return signature.ParserSignature.build("mineru", "1", {"v": self._sig})

    def parse(self, source_path: Path, workdir: Path, *, config, on_output=None) -> None:
        self.calls.append(source_path)
        (workdir / f"{source_path.stem}.md").write_text("# OCR'd text", encoding="utf-8")


def _use_map(monkeypatch, parsers: dict) -> None:
    monkeypatch.setattr(svc_mod, "get_parser", lambda name: parsers[name])


def test_empty_parse_falls_back_to_mineru(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary, ocr = _EmptyParser(), _OcrParser()
    _use_map(monkeypatch, {"pymupdf4llm": primary, "mineru": ocr})
    monkeypatch.setattr(
        svc_mod, "load_document_parsing_settings", lambda: {"ocr_fallback": True}
    )
    service = ParseService(cache_root=tmp_path / "cache")

    parsed = service.parse(_pdf(tmp_path), engine="pymupdf4llm")

    assert parsed.engine == "mineru"
    assert parsed.markdown == "# OCR'd text"
    assert len(primary.calls) == 1 and len(ocr.calls) == 1


def test_ocr_fallback_disabled_keeps_empty_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary, ocr = _EmptyParser(), _OcrParser()
    _use_map(monkeypatch, {"pymupdf4llm": primary, "mineru": ocr})
    monkeypatch.setattr(
        svc_mod, "load_document_parsing_settings", lambda: {"ocr_fallback": False}
    )
    service = ParseService(cache_root=tmp_path / "cache")

    with pytest.raises(ParserError, match="produced no content"):
        service.parse(_pdf(tmp_path), engine="pymupdf4llm")
    assert ocr.calls == []


def test_fallback_also_empty_raises_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use_map(monkeypatch, {"mineru": _EmptyParser()})
    monkeypatch.setattr(
        svc_mod, "load_document_parsing_settings", lambda: {"ocr_fallback": True}
    )
    service = ParseService(cache_root=tmp_path / "cache")

    with pytest.raises(ParserError, match="The 'mineru' engine produced no content"):
        service.parse(_pdf(tmp_path), engine="mineru")


def test_fallback_skipped_when_mineru_not_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    primary, ocr = _EmptyParser(), _OcrParser(ready=False)
    _use_map(monkeypatch, {"pymupdf4llm": primary, "mineru": ocr})
    monkeypatch.setattr(
        svc_mod, "load_document_parsing_settings", lambda: {"ocr_fallback": True}
    )
    service = ParseService(cache_root=tmp_path / "cache")

    with pytest.raises(ParserError, match="produced no content"):
        service.parse(_pdf(tmp_path), engine="pymupdf4llm")
    assert ocr.calls == []


def test_fallback_streams_notice(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _use_map(monkeypatch, {"pymupdf4llm": _EmptyParser(), "mineru": _OcrParser()})
    monkeypatch.setattr(
        svc_mod, "load_document_parsing_settings", lambda: {"ocr_fallback": True}
    )
    lines: list[str] = []

    def _sink(line: str) -> None:
        lines.append(line)

    ParseService(cache_root=tmp_path / "cache").parse(
        _pdf(tmp_path), engine="pymupdf4llm", on_output=_sink
    )
    assert any("fallback" in line and "mineru" in line for line in lines)
