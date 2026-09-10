"""Pre-OCR a scanned PDF into the parse cache (background helper).

Usage: python scripts/prewarm_ocr_cache.py <pdf-path>
Runs the MinerU engine directly so a later UI upload of the same bytes hits
the parse cache instead of OCR-ing for hours inside the HTTP request.
"""
import logging
import sys
import time
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

from deeptutor.services.parsing import get_parse_service

def main() -> int:
    if len(sys.argv) != 2:
        print("usage: prewarm_ocr_cache.py <pdf>")
        return 2
    path = Path(sys.argv[1])
    t0 = time.time()
    parsed = get_parse_service().parse(path, engine="mineru")
    print(f"DONE engine={parsed.engine} chars={len(parsed.markdown)} in {time.time()-t0:.0f}s")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
