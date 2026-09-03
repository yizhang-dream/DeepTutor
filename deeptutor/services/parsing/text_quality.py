"""Effective-text detection for scanned-PDF OCR fallbacks.

Figure-label text objects embedded in scanned pages (a few dozen
alphanumerics per document) are enough to defeat an ``any(unit.strip())``
check while carrying no readable prose, which let such files silently skip
the OCR fallback and surface as blank/whitespace content. Real text layers
run ≈1k+ alphanumeric characters per page, so judging the alnum count
against the page count separates the two cleanly.

Applied to PDFs only: other formats (md/epub notes) can legitimately be
tiny, and there is no page notion to density-check against.
"""

from __future__ import annotations

from pathlib import Path

# A document this texty is real prose; skip the density math entirely.
_ALNUM_LONG_DOC = 2500
# Below the long-doc shortcut, a document must carry at least this many
# alphanumerics in total...
_ALNUM_FLOOR = 200
# ...or at least this many per page, whichever is larger. Figure-label noise
# lands around 20-30/page; real text layers around 1k+/page.
_ALNUM_PER_PAGE = 60


def meaningful_text_alnum(text: str) -> int:
    """Count alphanumeric characters — the part of text that is prose."""
    return sum(1 for ch in (text or "") if ch.isalnum())


def pdf_page_count(source_path: Path) -> int:
    """Best-effort page count for a PDF; 1 when it cannot be determined."""
    try:
        import pymupdf

        with pymupdf.open(source_path) as doc:
            return max(1, doc.page_count)
    except Exception:  # noqa: BLE001 - density check must never break parsing
        return 1


def has_meaningful_text(text: str, *, page_count: int = 1) -> bool:
    """False when ``text`` is scan/figure-label noise rather than real prose.

    ``page_count`` should be the document's page count (density is judged
    per page so short notes don't false-positive while multi-page
    figure-noise scans still fail).
    """
    alnum = meaningful_text_alnum(text)
    if alnum >= _ALNUM_LONG_DOC:
        return True
    pages = max(1, page_count)
    return alnum >= max(_ALNUM_FLOOR, _ALNUM_PER_PAGE * pages)
