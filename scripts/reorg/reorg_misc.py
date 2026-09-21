"""Misc cleanup of the DeepTutor reading library: unmount duplicates, drop a
duplicated material row, delete two dead workspaces, and home two orphans.

One-shot maintenance script. Talks to the local backend at
http://localhost:8001 under /api/reading. No auth header required.

Steps (every material id is re-verified against its filename before acting):
  1. Unmount 3 materials from "physical" that are duplicated in "物理实验"
     (mount only — the material bodies stay, they still live in 物理实验).
  2. Delete the "大学物理下PPT纯享" workspace (its single session goes with it;
     the 3 material bodies are shared and stay in "physical").
  3. Delete the duplicate General Physics Assignment02 material row
     (4b7d208776e7d482) whose content is also carried by rm_6e2e838e6381.

     NOTE: this deletion does not last. The content lives in the store dir
     named after the content id (4b7d208776e7d482); GET /library/materials
     re-registers any content dir that has no catalog row
     (reading.py:433-435), so the row comes back on the next library listing.
     The alias rm_6e2e838e6381 keeps its material_id != content_id, and content
     ids must be hex (`^[0-9a-f]{8,64}$`, store.py:85), so the dir cannot be
     renamed after rm_ to make the row stay gone.
  4. Delete the empty www.zhihu.com workspace (0 materials, 0 sessions).
  5. Mount the two ungrouped orphans: Lewin's Genes XII -> 分子生物学,
     iGEM presentation -> 生物信息学.
  6. Delete the 01_Assignment 01.html link shell (2a028a2e010db08c).
"""
from __future__ import annotations

import sys

import requests

BASE = "http://localhost:8001/api/reading"

PHYSICAL = "rw_666b6ba9bde34afebe5d1e90b5d36221"
PHYSICS_LAB = "rw_8a072d5d36604bedb835f308803e00d7"
PPT_GROUP = "rw_3b4626d8c77c49dfaa72c8cb6c47c409"
ZHIHU = "rw_4a9456e9aeef47db92ef28c0759a1301"
MOL_BIO = "rw_e32d545485a3473c9f3d849e8cd7b906"
BIOINFO = "rw_3147012cf1c246ae98d1b42b91a68f1f"

# Unmount from "physical" only; bodies stay mounted in "物理实验".
UNMOUNT = {
    "Lab 1 Electrostatic Charges DATA sheet_update20260905.pdf": "7fcf207b0701b6d0",
    "Lab 1 Electrostatic Charges_update20260905.pdf": "cff9e801a697546c",
    "Lab 2 Resistivity_09262026.pdf": "813850e247afe3fc",
}

# Material row to drop: no-annotation twin of rm_6e2e838e6381 (same content_id).
DUP_ROW = "4b7d208776e7d482"
DUP_FILENAME = "General Physics Assignment02_fa26.docx"
KEPT_TWIN = "rm_6e2e838e6381"

# Orphans to home: filename -> (material_id, target workspace id, title).
MOUNT = {
    "Lewins Genes XII.Jones and Bartlett Learning.12th(2018) (Jocelyn E. Krebs, "
    "Elliott S. Goldstein etc.) (z-library.sk, 1lib.sk, z-lib.sk).pdf": (
        "ce55e815111c33bd",
        MOL_BIO,
        "分子生物学",
    ),
    "Yicen_Qiu_iGEM_Jamboree_Presentation (1).pptx": (
        "ca99fa893bca358f",
        BIOINFO,
        "生物信息学",
    ),
}

SHELL_ID = "2a028a2e010db08c"  # 01_Assignment 01.html

# Materials that must stay mounted in "physical" after step 2.
KEEP_IN_PHYSICAL = {
    "day03_GaussLaw.pdf": "66ca25db46bf8a41",
    "day04_potential.pdf": "d6172474e2b1d561",
    "General Physics Assignment02_fa26.docx": KEPT_TWIN,
}


def get(url: str, **kw):
    r = requests.get(url, timeout=30, **kw)
    r.raise_for_status()
    return r.json()


def workspace_by_id(ws_id: str) -> dict:
    for w in get(f"{BASE}/workspaces")["workspaces"]:
        if w["workspace_id"] == ws_id:
            return w
    raise SystemExit(f"workspace {ws_id} not found")


def filename_map(workspace: dict) -> dict[str, str]:
    return {t["material"]["filename"]: t["material"]["material_id"] for t in workspace["tabs"]}


def has_tab(workspace: dict, filename: str, material_id: str) -> bool:
    """True when the workspace holds this exact (filename, material_id) tab.

    Filenames are not unique (physical carries two Assignment02 rows), so the
    check cannot go through a filename->id map.
    """
    return any(
        t["material"]["material_id"] == material_id
        and t["material"]["filename"] == filename
        for t in workspace["tabs"]
    )


def has_material(workspace: dict, material_id: str) -> bool:
    return any(t["material"]["material_id"] == material_id for t in workspace["tabs"])


def material_row(material_id: str) -> dict | None:
    for m in get(f"{BASE}/library/materials")["materials"]:
        if m["material_id"] == material_id:
            return m
    return None


def main() -> None:
    # ---- preconditions: verify every id against its filename ------------
    phys = workspace_by_id(PHYSICAL)
    print(f"[0] physical: {len(phys['tabs'])} materials (expect 33)")
    assert len(phys["tabs"]) == 33, len(phys["tabs"])
    names = filename_map(phys)
    for fn, mid in UNMOUNT.items():
        assert names.get(fn) == mid, f"{fn}: expected {mid}, found {names.get(fn)}"
    dup = material_row(DUP_ROW)
    assert dup is not None, "dup row missing"
    assert dup["filename"] == DUP_FILENAME, dup["filename"]
    assert has_tab(phys, DUP_FILENAME, KEPT_TWIN), "twin not mounted in physical"
    shell = material_row(SHELL_ID)
    assert shell is not None and shell["filename"] == "01_Assignment 01.html", shell
    for fn, (mid, _, _) in MOUNT.items():
        row = material_row(mid)
        assert row is not None and row["filename"] == fn, (mid, row and row["filename"])
        assert not row.get("collections"), f"{mid} already grouped: {row['collections']}"
    lab = workspace_by_id(PHYSICS_LAB)
    print(f"[0] 物理实验: {len(lab['tabs'])} materials (expect 10)")
    assert len(lab["tabs"]) == 10, len(lab["tabs"])
    print("[0] all ids verified against filenames")

    # ---- step 1: unmount the 3 duplicates from "physical" ---------------
    for fn, mid in UNMOUNT.items():
        r = requests.delete(f"{BASE}/workspaces/{PHYSICAL}/materials/{mid}", timeout=30)
        r.raise_for_status()
        print(f"[1] unmounted {fn} ({mid}) from physical")
    assert len(workspace_by_id(PHYSICAL)["tabs"]) == 30, "physical should hold 30"

    # ---- step 2: delete the 大学物理下PPT纯享 workspace ------------------
    group = workspace_by_id(PPT_GROUP)
    assert group["title"] == "大学物理下PPT纯享", group["title"]
    assert len(group["tabs"]) == 3, len(group["tabs"])
    sessions = get(f"{BASE}/workspaces/{PPT_GROUP}/sessions")["sessions"]
    print(f"[2] {group['title']!r}: {len(group['tabs'])} materials, {len(sessions)} session(s)")
    assert len(sessions) == 1, len(sessions)
    r = requests.delete(f"{BASE}/workspaces/{PPT_GROUP}", timeout=30)
    r.raise_for_status()
    print(f"[2] deleted workspace {PPT_GROUP}: {r.json()}")
    phys2 = workspace_by_id(PHYSICAL)
    for fn, mid in KEEP_IN_PHYSICAL.items():
        assert has_tab(phys2, fn, mid), f"{fn} lost from physical"
    print("[2] day03_GaussLaw / day04_potential / Assignment02 still in physical")

    # ---- step 3: drop the duplicate Assignment02 material row -----------
    r = requests.delete(f"{BASE}/materials/{DUP_ROW}", timeout=30)
    r.raise_for_status()
    print(f"[3] deleted dup row {DUP_ROW}: {r.json()}")
    assert material_row(KEPT_TWIN) is not None, "twin row gone too"
    assert has_material(workspace_by_id(PHYSICAL), KEPT_TWIN), "twin lost from physical"

    # ---- step 4: delete the empty zhihu workspace -----------------------
    zhihu = workspace_by_id(ZHIHU)
    assert "zhihu.com" in zhihu["title"], zhihu["title"]
    assert len(zhihu["tabs"]) == 0, len(zhihu["tabs"])
    assert get(f"{BASE}/workspaces/{ZHIHU}/sessions")["sessions"] == []
    r = requests.delete(f"{BASE}/workspaces/{ZHIHU}", timeout=30)
    r.raise_for_status()
    print(f"[4] deleted empty workspace {ZHIHU}: {r.json()}")

    # ---- step 5: mount the two orphans ----------------------------------
    for fn, (mid, wid, title) in MOUNT.items():
        r = requests.post(f"{BASE}/workspaces/{wid}/materials",
                          json={"material_id": mid}, timeout=30)
        r.raise_for_status()
        print(f"[5] mounted {fn} ({mid}) -> {title} ({wid})")

    # ---- step 6: delete the 01_Assignment 01.html shell -----------------
    r = requests.delete(f"{BASE}/materials/{SHELL_ID}", timeout=30)
    r.raise_for_status()
    print(f"[6] deleted link shell {SHELL_ID}: {r.json()}")

    # ---- verification ---------------------------------------------------
    print("\n===== VERIFY =====")
    ws = {w["workspace_id"]: w for w in get(f"{BASE}/workspaces")["workspaces"]}
    print(f"workspace count      : {len(ws)}")
    print(f"physical             : {len(ws[PHYSICAL]['tabs'])} (expect 29)")
    print(f"物理实验              : {len(ws[PHYSICS_LAB]['tabs'])} (expect 10)")
    print(f"分子生物学            : {len(ws[MOL_BIO]['tabs'])} (expect 5)")
    print(f"生物信息学            : {len(ws[BIOINFO]['tabs'])} (expect 2)")
    print(f"大学物理下PPT纯享 gone: {PPT_GROUP not in ws}")
    print(f"zhihu gone           : {ZHIHU not in ws}")
    lib = get(f"{BASE}/library/materials")
    print(f"library counts       : {lib['counts']}")
    unassigned = [m["material_id"] for m in lib["materials"] if not m.get("collections")]
    print(f"unassigned           : {unassigned}")


if __name__ == "__main__":
    sys.exit(main())
