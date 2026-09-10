#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""论文批量入库一条龙:下载 → 体检 → 修复 → KB → 阅读区 → 合集 → 验收报告。

用法(用 DeepTutor venv 的 python 跑,需要 pymupdf):
    D:/DeepTutor/venv/Scripts/python.exe scripts/ingest_papers.py \
        --manifest books/rl-milestones/manifest.json \
        --dir books/rl-milestones --collection "rl paper" --kb paper-rl-milestones

manifest 每条字段:
    {"no": "01", "year": "1950", "slug": "turing", "authors": "...",
     "title": "...", "venue": "...", "urls": ["https://...pdf", ...]}

已存在的同名 PDF 跳过下载;KB 已有同名文件跳过上传;阅读区已有同名材料
跳过(幂等,可反复跑)。仅合法渠道:arXiv/OpenAlex 解析的 OA 直链/作者页。
"""
from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import json
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
PDF_MAGIC = b"%PDF"
API = "http://localhost:8001"


def log(msg: str) -> None:
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


# ---------------------------------------------------------------- S1 下载 ----

def _fetch(url: str, timeout: int = 45) -> bytes:
    req = urllib.request.Request(url, headers=UA)
    data = urllib.request.urlopen(req, timeout=timeout).read()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    if data[:4] != PDF_MAGIC:
        raise ValueError("not a PDF")
    return data


def download_all(entries: list[dict], target_dir: Path) -> dict[str, str]:
    """下载缺失的 PDF;返回 slug -> 状态(ok / exists / fail 原因)。"""
    status: dict[str, str] = {}
    for e in entries:
        dest = target_dir / f"{e['no']}_{e['year']}_{e['slug']}.pdf"
        if dest.exists() and dest.read_bytes()[:4] == PDF_MAGIC:
            status[e["slug"]] = "exists"
            continue
        last = ""
        for url in e.get("urls", []):
            try:
                dest.write_bytes(_fetch(url))
                status[e["slug"]] = f"downloaded {url}"
                log(f"下载 {dest.name} <- {url}")
                break
            except Exception as exc:  # noqa: BLE001
                last = f"{type(exc).__name__}: {exc}"[:90]
        else:
            status[e["slug"]] = f"FAIL {last}"
            log(f"下载失败 {dest.name}: {last}")
    return status


# ------------------------------------------------------------- S2/S3 体检 ----

def health_check_and_repair(path: Path) -> dict:
    """返回 {pdfium, ccitt, text_ok, repaired:[...]}。"""
    import pymupdf

    info = {"pdfium": True, "ccitt": False, "text_ok": True, "repaired": []}
    # PDFium 加载(DeepTutor 主链同款严格度)
    try:
        import pypdfium2 as pdfium
        p = pdfium.PdfDocument(path)
        n_pages = max(1, len(p))
        p.close()
    except Exception:
        d = pymupdf.open(path)
        n_pages = max(1, d.page_count)
        tmp = path.with_suffix(".fix.pdf")
        d.save(tmp, garbage=4, deflate=True, clean=True)
        d.close()
        shutil.move(tmp, path)
        info["pdfium"] = False
        info["repaired"].append("pdfium-resave")

    d = pymupdf.open(path)
    alnum = 0
    for pg in d:
        alnum += sum(1 for ch in pg.get_text() if ch.isalnum())
        for im in pg.get_images(full=True):
            obj = d.xref_object(im[0], compressed=True)
            if "CCITTFaxDecode" in obj or "JBIG2Decode" in obj:
                info["ccitt"] = True
    # 文本层密度:与服务端同款阈值(长文 2500 / 每页 60)
    info["text_ok"] = alnum >= 2500 or alnum >= max(200, 60 * n_pages)
    d.close()

    if info["ccitt"] or not info["text_ok"]:
        # 光栅化:去 CCITT/弱文本层,让浏览器可渲染 + 服务端走 mineru-ocr
        d = pymupdf.open(path)
        dst = pymupdf.open()
        for pg in d:
            pix = pg.get_pixmap(dpi=200)
            np = dst.new_page(width=pg.rect.width, height=pg.rect.height)
            np.insert_image(np.rect, pixmap=pix)
        tmp = path.with_suffix(".ras.pdf")
        dst.save(tmp, deflate=True, garbage=4)
        n = dst.page_count
        dst.close()
        d.close()
        shutil.move(tmp, path)
        why = "ccitt" if info["ccitt"] else "weak-text"
        info["repaired"].append(f"rasterize({why},{n}p)")
    return info


# ----------------------------------------------------------- S4 扫描件预热 ----

def prewarm_scans(files: list[Path]) -> None:
    """用 DeepTutor 的 ParseService 预跑 mineru,写入内容寻址解析缓存。"""
    from deeptutor.services.parsing import get_parse_service

    svc = get_parse_service()
    for f in files:
        t0 = time.time()
        try:
            parsed = svc.parse(f, engine="mineru")
            log(f"prewarm {f.name}: {len(parsed.markdown)} chars in {time.time()-t0:.0f}s")
        except Exception as exc:  # noqa: BLE001
            log(f"prewarm {f.name} FAILED: {exc}")


# --------------------------------------------------------------- S5 KB 入库 ----

def kb_create_or_upload(kb: str, files: list[Path], api: str) -> None:
    """KB 不存在则 /create(必须带文件),已存在则 /upload 增量。"""
    import requests

    kb_exists = True
    try:
        requests.get(f"{api}/api/v1/knowledge/{kb}", timeout=15).raise_for_status()
    except requests.HTTPError:
        kb_exists = False
    except Exception:  # noqa: BLE001
        kb_exists = False

    files_payload = [("files", (f.name, f.read_bytes(), "application/pdf")) for f in files]
    if kb_exists:
        r = requests.post(f"{api}/api/v1/knowledge/{kb}/upload", files=files_payload, timeout=600)
        log(f"KB {kb} /upload: HTTP {r.status_code}({len(files)} 个文件)")
    else:
        data = [("name", kb), ("rag_provider", "llamaindex")] + [("rel_paths", f.name) for f in files]
        r = requests.post(f"{api}/api/v1/knowledge/create", files=files_payload, data=data, timeout=600)
        log(f"KB {kb} /create: HTTP {r.status_code}({len(files)} 个文件)")
    r.raise_for_status()


# ----------------------------------------------------------- S6/S7 阅读区 ----

def reading_upload_all(files: list[Path], api: str, workers: int = 2) -> dict[str, dict]:
    """并发上传(async=true,202 即认为入队),轮询列表直到每篇可见。"""
    import requests

    def upload_one(f: Path) -> None:
        try:
            r = requests.post(f"{api}/api/v1/reading/materials", params={"async": "true"},
                              files={"file": (f.name, f.read_bytes(), "application/pdf")}, timeout=60)
            log(f"阅读区入队 {f.name}: HTTP {r.status_code} {r.text[:80]}")
        except Exception as exc:  # noqa: BLE001
            log(f"阅读区上传 {f.name} 异常(可能仍在处理): {exc}")

    with concurrent.futures.ThreadPoolExecutor(workers) as ex:
        list(ex.map(upload_one, files))

    # 轮询直到全部出现(超时 40 分钟)
    deadline = time.time() + 2400
    pending = {f.name for f in files}
    result: dict[str, dict] = {}
    while pending and time.time() < deadline:
        time.sleep(20)
        try:
            items = json.loads(urllib.request.urlopen(f"{api}/api/v1/reading/materials", timeout=20).read())
            items = items if isinstance(items, list) else items.get("materials", [])
            by_name = {x.get("filename"): x for x in items}
        except Exception:
            continue
        for name in list(pending):
            if name in by_name:
                x = by_name[name]
                result[name] = {"id": x.get("material_id"), "chars": x.get("char_count"),
                                "extractor": x.get("extractor")}
                log(f"阅读区就绪 {name}: chars={x.get('char_count')} extractor={x.get('extractor')}")
                pending.discard(name)
    for name in pending:
        result[name] = {"id": None, "chars": None, "extractor": "TIMEOUT"}
        log(f"阅读区超时 {name}(服务端可能仍在处理,稍后重跑脚本核对)")
    return result


def ensure_collection(name: str, files: list[Path], upload_result: dict, api: str) -> str:
    import requests

    ws = None
    items = requests.get(f"{api}/api/v1/reading/workspaces", timeout=20).json()
    items = items if isinstance(items, list) else items.get("workspaces", [])
    for x in items:
        if x.get("title") == name:
            ws = x.get("workspace_id")
            break
    if not ws:
        r = requests.post(f"{api}/api/v1/reading/workspaces", json={"title": name, "description": ""}, timeout=30)
        r.raise_for_status()
        d = r.json()
        ws = d.get("workspace_id") or d.get("id")
    for f in files:
        mid = (upload_result.get(f.name) or {}).get("id")
        if not mid:
            continue
        # 已在合集里会 40x,忽略
        requests.post(f"{api}/api/v1/reading/workspaces/{ws}/materials",
                      json={"material_id": mid}, timeout=30)
    return ws


# --------------------------------------------------------------- S8 验收 ----

def wait_kb_ready(kb: str, api: str, timeout_s: int = 1800) -> None:
    """KB /create、/upload 都是后台处理,验收前等状态 ready。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            d = json.loads(urllib.request.urlopen(f"{api}/api/v1/knowledge/{kb}", timeout=20).read())
            if d.get("status") == "ready":
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(15)
    log(f"KB {kb} 等待 ready 超时({timeout_s}s),验收报告可能不完整")


def acceptance_report(kb: str, files: list[Path], api: str, out: Path) -> dict:
    report: dict = {"kb": kb, "files": len(files), "problems": []}
    wait_kb_ready(kb, api)
    corpus = PROJECT_ROOT / "data" / "knowledge_bases" / kb / "version-1" / "bm25_retriever" / "corpus.jsonl"
    counts: dict[str, int] = {}
    if corpus.exists():
        for line in corpus.open(encoding="utf-8"):
            try:
                d = json.loads(line)
            except Exception:
                continue
            fn = (d.get("metadata") or {}).get("file_name") or "?"
            counts[fn] = counts.get(fn, 0) + 1
        report["kb_chunks_total"] = sum(counts.values())
        empties = [f.name for f in files if counts.get(f.name, 0) <= 1]
        report["problems"] += [f"KB 单块/空块: {x}" for x in empties]
    missing_kb = [f.name for f in files if f.suffix == ".pdf" and f.name not in counts]
    report["problems"] += [f"KB 未索引: {x}" for x in missing_kb]
    out.write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"验收报告 -> {out}")
    return report


# ------------------------------------------------------------------ main ----

def main() -> int:
    ap = argparse.ArgumentParser(description="论文批量入库一条龙")
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--dir", default=None, help="PDF 存放目录(默认 manifest 同目录)")
    ap.add_argument("--kb", default="paper-papers")
    ap.add_argument("--collection", default=None, help="阅读区合集名(默认不挂合集)")
    ap.add_argument("--api", default=API)
    ap.add_argument("--skip-download", action="store_true")
    ap.add_argument("--no-kb", action="store_true")
    ap.add_argument("--no-reading", action="store_true")
    ap.add_argument("--prewarm", action="store_true", help="扫描件入库前预跑 OCR 进缓存")
    ap.add_argument("--workers", type=int, default=2)
    args = ap.parse_args()

    manifest_path = Path(args.manifest)
    target_dir = Path(args.dir) if args.dir else manifest_path.parent
    target_dir.mkdir(parents=True, exist_ok=True)
    entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = [target_dir / f"{e['no']}_{e['year']}_{e['slug']}.pdf" for e in entries]

    if not args.skip_download:
        st = download_all(entries, target_dir)
        fails = {k: v for k, v in st.items() if v.startswith("FAIL")}
        if fails:
            log(f"{len(fails)} 篇下载失败,详见上方日志(继续处理已就绪的)")

    log("=== S2/S3 体检与修复 ===")
    scan_like: list[Path] = []
    for f in files:
        if not f.exists():
            continue
        info = health_check_and_repair(f)
        tag = ",".join(info["repaired"]) or "clean"
        print(f"  {f.name}: pdfium={info['pdfium']} ccitt={info['ccitt']} text={info['text_ok']} [{tag}]")
        if info["ccitt"] or not info["text_ok"]:
            scan_like.append(f)

    if args.prewarm and scan_like:
        log(f"=== S4 预热 {len(scan_like)} 个扫描件(写入解析缓存)===")
        prewarm_scans(scan_like)

    pdfs = [f for f in files if f.exists()]
    if not args.no_kb and pdfs:
        log(f"=== S5 KB 入库 {len(pdfs)} 篇 -> {args.kb} ===")
        kb_create_or_upload(args.kb, pdfs, args.api)

    upload_result: dict = {}
    if not args.no_reading and pdfs:
        log(f"=== S6 阅读区入库 {len(pdfs)} 篇 ===")
        upload_result = reading_upload_all(pdfs, args.api, workers=args.workers)
        if args.collection:
            log(f"=== S7 挂合集 [{args.collection}] ===")
            ensure_collection(args.collection, pdfs, upload_result, args.api)

    log("=== S8 验收 ===")
    acceptance_report(args.kb, pdfs, args.api, target_dir / "_acceptance_report.json")
    log("完成。检索验收请到 DeepTutor 界面对库提问。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
