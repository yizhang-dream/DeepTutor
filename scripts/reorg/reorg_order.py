"""阅读区全库各组材料按序排列（13 组）。

纯 API 操作（requests），后端 http://localhost:8001，路由 /api/reading/*，无需认证头。
排序端点 PUT /api/reading/workspaces/{wid}/materials/order，body {"material_ids": [...]}
必须传该组当前全集（缺一个报错），因此本脚本每组先 GET 现有全集、按规则排出目标序、再 PUT。

幂等：可反复重跑。rl paper 与 强化学习课程 已排好，本脚本不动它们。

跑法：python scripts/reorg/reorg_order.py
"""

from __future__ import annotations

import re
import sys

import requests

BASE = "http://localhost:8001/api/reading"

# 已排好、不动的组
SKIP_TITLES = {"rl paper", "强化学习课程"}

# 物理旧讲义：按 day 编号自然序（day05_extra 紧跟 day05，day12a -> day12b，day25a -> day25b）
# 后缀取 dayNN 后紧邻的 [_a-z] 串（去掉前导下划线），保证同号文件（如 day05 与
# day05_extra、day12a 与 day12b）之间总序确定，不依赖 API 返回的原始顺序。
_DAY_RE = re.compile(r"day(\d+)(_?[a-z]*)")


def day_key(filename: str):
    m = _DAY_RE.search(filename.lower())
    if not m:
        raise ValueError(f"no day number in {filename}")
    return (int(m.group(1)), m.group(2).lstrip("_"))


def name_key(filename: str) -> str:
    return filename.lower()


# 每组：标题 -> 有序 bucket 列表，每项 (token, 次级排序 key)。
# token 用不区分大小写的子串匹配；一个 material 归入首个命中的 bucket。
# 除「物理旧讲义」单 bucket 收 31 件外，其余组每 bucket 恰好命中 1 件。
ORDER_SPECS: dict[str, list[tuple[str, object]]] = {
    "物理学A下": [
        ("day01", name_key),
        ("day02", name_key),
        ("day03", name_key),
        ("day04", name_key),
        ("day05", name_key),
        ("day06", name_key),
        ("Assignment01", name_key),
        ("Assignment02", name_key),
        ("Assignment03", name_key),
        ("第一课", name_key),
        ("第二课", name_key),
        ("Syllabus", name_key),
    ],
    "物理参考书": [
        ("university-physics-volume-1.pdf", name_key),
        ("university-physics-volume-2.pdf", name_key),
        ("university-physics-volume-3.pdf", name_key),
        ("volume-1_summary", name_key),
        ("volume-2_summary", name_key),
        ("volume-3_summary", name_key),
        ("physformulary", name_key),
        ("single-page-integral-table", name_key),
        ("Approximation_and_Taylor_Series", name_key),
        ("On_Keplers_Laws", name_key),
        ("Westlake_Physics_Vocabulary.csv", name_key),
        ("Westlake_Physics_Vocabulary.docx", name_key),
        ("英语单词读音规则", name_key),
        ("Decoding_Physics_English", name_key),
    ],
    "物理旧讲义": [
        ("PHYA2-day", day_key),
    ],
    "物理实验": [
        ("DATA sheet_update20260905", name_key),   # Lab 1 DATA sheet (pdf, 新版)
        ("DATA_sheet_update09122025", name_key),   # Lab 1 DATA sheet (docx)
        ("Lab 1 Electrostatic Charges_update", name_key),  # Lab 1 主件
        ("Lab 2 Fall 2026 Schedule", name_key),    # Lab 2 Schedule 在前
        ("Lab 2 Resistivity", name_key),
        ("Lab 3 Capacitance", name_key),
        ("P and N Hall effect", name_key),
        ("Millikan-Oil-Drop", name_key),
        ("Compton Scattering", name_key),
    ],
    "离散数学": [
        ("lecture1_introduction", name_key),
        ("lecture2_predicate_logic_classroom", name_key),
        ("lecture3_proof_techniques", name_key),
        ("lecture4_set_theory", name_key),
        ("lecture5_relationship", name_key),
        ("lecture6_number_theory", name_key),
        ("lecture7_basic_counting", name_key),
        ("lecture8_advanced_counting", name_key),
        ("lecture9_generating_functions", name_key),
        ("lecture10_graph_theory_1", name_key),
        ("lecture11_graph_theory_2", name_key),
        ("lecture12_graph_theory_3", name_key),
        ("lecture13_algorithm_complexity_recurrence", name_key),
        ("lecture14_concentration_inequalities", name_key),
        ("lecture15_randomization_techniques", name_key),
        ("lecture16_review_and_applications", name_key),
        ("第一课", name_key),
        ("第二课", name_key),
    ],
    "概率统计": [
        ("Chapter1", name_key),
        ("Chapter2", name_key),
        ("Chapter3", name_key),
        ("Assignment1", name_key),
        ("Assignment2", name_key),
        ("PASParticipation1", name_key),
        ("DeGroot", name_key),
        ("Hogg-Craig", name_key),
        ("Linde", name_key),
        ("Panaretos", name_key),
    ],
    "数字人": [
        ("00 Course Overview", name_key),
        ("W1-1", name_key),
        ("W1-2", name_key),
        ("W1-3", name_key),
        ("W2-1", name_key),
        ("W2-2", name_key),
        ("W2-3", name_key),
        ("FP0 ", name_key),
        ("FP1A", name_key),
        ("FP4A", name_key),
        ("FP4B", name_key),
        ("FP5 ", name_key),
        ("FP6A", name_key),
        ("FP8A", name_key),
        ("FP9A", name_key),
        ("FP10A 数字人数据采集 CN", name_key),
        ("FP10A Digital Human Data Acquisition EN", name_key),
        ("数字人-第二周-听课笔记", name_key),
    ],
    "分子生物学": [
        ("CH01", name_key),
        ("CH02", name_key),
        ("CH03", name_key),
        ("CH04", name_key),
        ("Lewins Genes", name_key),
    ],
    "生物化学": [
        ("Chapter 1", name_key),
        ("Chapter 2", name_key),
        ("Ch03", name_key),
    ],
    "生物统计学": [
        ("Chapters 1-2", name_key),
        ("Chapter 3", name_key),
        ("Chapter 4", name_key),
        ("Chapter 5", name_key),
    ],
    "马原": [
        ("导论_canvas", name_key),
        ("03_逻辑", name_key),
    ],
    "生物信息学": [
        ("2-Sequence_Motif", name_key),
        ("iGEM", name_key),
    ],
}


def get_json(url: str) -> dict:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    return r.json()


def tabs_of(workspace: dict) -> list[dict]:
    return sorted(workspace["tabs"], key=lambda t: t["tab_order"])


def ordered_filenames(workspace: dict) -> list[str]:
    return [t["material"]["filename"] for t in tabs_of(workspace)]


def compute_order(materials: list[dict], buckets: list[tuple[str, object]]) -> list[dict]:
    """materials: [{"material_id","filename"}] -> 按 buckets 排好的同一列表。"""
    assign: dict[str, int] = {}
    for m in materials:
        fn = m["filename"].lower()
        for i, (tok, _key) in enumerate(buckets):
            if tok.lower() in fn:
                assign[m["material_id"]] = i
                break
        else:
            raise SystemExit(f"  ! no bucket matches: {m['filename']}")

    # 校验：除单 bucket 组外，每个 bucket 应恰好命中 1 件
    counts: dict[int, int] = {}
    for i in assign.values():
        counts[i] = counts.get(i, 0) + 1
    if len(buckets) > 1:
        for i, (tok, _key) in enumerate(buckets):
            n = counts.get(i, 0)
            if n != 1:
                raise SystemExit(f"  ! bucket {tok!r} matched {n} materials (expected 1)")

    return sorted(
        materials,
        key=lambda m: (
            assign[m["material_id"]],
            buckets[assign[m["material_id"]]][1](m["filename"]),
        ),
    )


def main() -> int:
    workspaces = get_json(f"{BASE}/workspaces")["workspaces"]
    by_title = {w["title"]: w for w in workspaces}

    # 预检：目标组都在
    for title in ORDER_SPECS:
        if title not in by_title:
            raise SystemExit(f"workspace not found: {title}")
    print(f"待排序 {len(ORDER_SPECS)} 组；跳过 {sorted(SKIP_TITLES)}\n")

    failures: list[str] = []
    for title, buckets in ORDER_SPECS.items():
        ws = by_title[title]
        wid = ws["workspace_id"]
        tabs = tabs_of(ws)
        materials = [
            {"material_id": t["material"]["material_id"], "filename": t["material"]["filename"]}
            for t in tabs
        ]
        print(f"=== {title}  ({len(materials)} 件)  {wid}")

        target = compute_order(materials, buckets)
        target_ids = [m["material_id"] for m in target]

        # 必须传全集，缺一即报错
        if set(target_ids) != set(m["material_id"] for m in materials):
            raise SystemExit(f"  ! order set mismatch in {title}")
        if len(target_ids) != len(materials):
            raise SystemExit(f"  ! duplicate ids in {title}")

        r = requests.put(
            f"{BASE}/workspaces/{wid}/materials/order",
            json={"material_ids": target_ids},
            timeout=30,
        )
        status = r.status_code
        if status >= 400:
            failures.append(f"{title}: HTTP {status} {r.text[:200]}")
            print(f"  ! PUT failed: HTTP {status} {r.text[:200]}")
            continue

        # 回读确认
        after = ordered_filenames(next(w for w in get_json(f"{BASE}/workspaces")["workspaces"]
                                       if w["workspace_id"] == wid))
        ok = after == [m["filename"] for m in target]
        print(f"  PUT HTTP {status}  {'OK' if ok else 'ORDER MISMATCH'}")
        for i, fn in enumerate(after, 1):
            print(f"    {i:2d}. {fn}")
        if not ok:
            failures.append(f"{title}: post-PUT order mismatch")
        print()

    if failures:
        print("FAILURES:")
        for f in failures:
            print("  -", f)
        return 1
    print("DONE: all groups reordered, all PUT 200.")
    return 0


if __name__ == "__main__":
    sys.exit(main())