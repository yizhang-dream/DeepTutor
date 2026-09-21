"""阅读区大扫除第二波：物理组改名 + 参考书拆分 + 空壳/旧版删除。

纯 API 操作（requests），后端 http://localhost:8001，路由 /api/reading/*。
跑法：python scripts/reorg/reorg_physical.py
"""

from __future__ import annotations

import sys

import requests

BASE = "http://localhost:8001/api/reading"

# physical 组（即将改名为「物理学A下」）
WS_PHYSICAL = "rw_666b6ba9bde34afebe5d1e90b5d36221"

# 从 physical 搬到新组「物理参考书」的 14 件
MOVE_IDS = [
    "64b5e39f800a1084",  # physformulary_v128d
    "68e898b5685f725e",  # On_Keplers_Laws
    "1ba5fe9343454f56",  # single-page-integral-table_updated
    "8b2c5d5fb73a0d0d",  # Approximation_and_Taylor_Series_Kleppner
    "46e013981fa92a1d",  # Decoding_Physics_English_-_Syllables_and_Stress.pptx
    "18173f6c120ac6cf",  # Westlake_Physics_Vocabulary.csv.txt
    "7be345ad47f80e0d",  # Westlake_Physics_Vocabulary.docx
    "61c9cfada03c7262",  # 英语单词读音规则-初汉平2016
    "93652b69c43197d1",  # university-physics-volume-1
    "3f5d8d0e38ba663c",  # volume-2
    "311c6beb70bb9cc6",  # volume-3
    "3582f9dd2268622f",  # vol1_summary
    "c170fc898b233145",  # vol2_summary
    "1d84cf9bdcdf8bca",  # vol3_summary
]

# 删除的 HTML 空壳（挂载级联清）
DELETE_HTML_IDS = [
    "0f4a15efe6ef6d87",  # 03_考勤_Attendance.html（挂 4 组）
    "0fb295f73f7c7b26",  # 02_Quiz 2.html
    "e38bcc58ba9a22f0",  # 02_ClassParticipation1.html
    "e7681ee73f5a6ad3",  # 01_Quiz 1.html
    "99d12536925264fd",  # 04_Assignment1.html
    "e4b2360af1e4505b",  # 05_Assignment2.html
    "466e1df78c5a72d5",  # 01_我心目中的马克思.html
    "fb9abb1cb386a51b",  # 02_Assignment 02.html
    "2353395311c5be93",  # 04_Assignment 03.html
    "38a8a1fa622899ac",  # 01_Lab02-resistivity.html
]

# 离散数学 2025 旧版 lecture1/2/3（lecture4-16 只有一套，保留）
DELETE_OLD_DISCRETE_IDS = [
    "824b73f71a0d7b50",  # lecture1_introduction
    "ac0ac19930e9ab7d",  # lecture2_predicate_logic
    "bdac764a4a06fee5",  # lecture3_proof_techniques
]


def check(resp: requests.Response, what: str) -> dict:
    if resp.status_code >= 400:
        raise SystemExit(f"FAIL {what}: HTTP {resp.status_code} {resp.text[:300]}")
    print(f"  ok  {what}  (HTTP {resp.status_code})")
    try:
        return resp.json()
    except ValueError:
        return {}


def main() -> None:
    s = requests.Session()

    print("1) PATCH 组名 -> 物理学A下")
    r = check(
        s.patch(f"{BASE}/workspaces/{WS_PHYSICAL}", json={"title": "物理学A下"}),
        "rename physical -> 物理学A下",
    )
    assert r["workspace"]["workspace_id"] == WS_PHYSICAL, "workspace id changed!"
    print(f"     id 不变: {r['workspace']['workspace_id']}")

    print("2) 新建组 物理参考书")
    r = check(
        s.post(
            f"{BASE}/workspaces",
            json={
                "title": "物理参考书",
                "description": "2183 References：教材、公式表、词汇等参考材料",
            },
        ),
        "create 物理参考书",
    )
    ref_id = r["workspace"]["workspace_id"]
    print(f"     new workspace: {ref_id}")

    print("3) 14 件搬入 物理参考书（先挂后摘）")
    for mid in MOVE_IDS:
        check(
            s.post(f"{BASE}/workspaces/{ref_id}/materials", json={"material_id": mid}),
            f"attach {mid} -> 物理参考书",
        )
        check(
            s.delete(f"{BASE}/workspaces/{WS_PHYSICAL}/materials/{mid}"),
            f"detach {mid} from 物理学A下",
        )

    print("4) 删 10 件 HTML 空壳")
    for mid in DELETE_HTML_IDS:
        check(s.delete(f"{BASE}/materials/{mid}"), f"delete material {mid}")

    print("5) 删离散数学 2025 旧版 3 件")
    for mid in DELETE_OLD_DISCRETE_IDS:
        check(s.delete(f"{BASE}/materials/{mid}"), f"delete material {mid}")

    print("DONE")


if __name__ == "__main__":
    main()