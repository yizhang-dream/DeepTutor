"""Reorganize DeepTutor reading materials: split the RL course items out of
the "rl paper" workspace.

One-shot maintenance script. Talks to the local backend at
http://localhost:8001 under /api/reading. No auth header required.

Steps (all material ids are re-verified against filenames before acting):
  1. Confirm "rl paper" workspace id and 5 ids to move.
  2. Create the "强化学习课程" workspace.
  3. Move 5 materials: attach to the new workspace first, then detach from
     "rl paper" (attach-then-detach, never the other way around).
  4. Delete the upload test material 99_2017_smoke-paper.pdf.
  5. Attach the ungrouped 01_1950_turing.pdf to "rl paper".
  6. Reorder both workspaces.
"""
from __future__ import annotations

import re
import sys

import requests

BASE = "http://localhost:8001/api/reading"
RL_PAPER = "rw_ee8fdafca0064adf96461e98b888823b"

NEW_TITLE = "强化学习课程"
NEW_DESCRIPTION = "Canvas 2043 强化学习原理：课件、作业、听课笔记"

# filename -> expected material_id, moved from "rl paper" to the new workspace.
MOVE = {
    "L1-Basic concepts.pdf": "507f7487ce1aa028",
    "强化学习-L1基础概念-听课笔记.epub": "3e7c6ed3065178d1",
    "01_Assignment 1.html": "e761b2f1c257fc95",
    "02_Assignment 2 - Solve Bellman equation.html": "02fff3ac9787f967",
    "project.pdf": "5a886a1c0c09396e",
}
NEW_ORDER = [
    "L1-Basic concepts.pdf",
    "强化学习-L1基础概念-听课笔记.epub",
    "01_Assignment 1.html",
    "02_Assignment 2 - Solve Bellman equation.html",
    "project.pdf",
]

SMOKE_ID = "bdfaa68d8984f0dc"  # 99_2017_smoke-paper.pdf
TURING_ID = "3cd7c57944b7b53f"  # 01_1950_turing.pdf


def get(url: str, **kw):
    r = requests.get(url, timeout=30, **kw)
    r.raise_for_status()
    return r.json()


def tabs_of(workspace: dict) -> list[dict]:
    return sorted(workspace["tabs"], key=lambda t: t["tab_order"])


def filename_map(workspace: dict) -> dict[str, str]:
    return {t["material"]["filename"]: t["material"]["material_id"] for t in workspace["tabs"]}


def ordered_filenames(workspace: dict) -> list[str]:
    return [t["material"]["filename"] for t in tabs_of(workspace)]


def workspace_by_id(ws_id: str) -> dict:
    for w in get(f"{BASE}/workspaces")["workspaces"]:
        if w["workspace_id"] == ws_id:
            return w
    raise SystemExit(f"workspace {ws_id} not found")


def num_key(filename: str):
    m = re.match(r"(\d+)_", filename)
    if not m:
        raise ValueError(f"no numeric prefix: {filename}")
    return int(m.group(1))


def main() -> None:
    # ---- step 1: verify preconditions -----------------------------------
    rl = workspace_by_id(RL_PAPER)
    names = filename_map(rl)
    print(f"[1] rl paper: {len(rl['tabs'])} materials")
    assert len(rl["tabs"]) == 35, f"expected 35, got {len(rl['tabs'])}"
    for fn, mid in MOVE.items():
        assert names.get(fn) == mid, f"{fn}: expected {mid}, found {names.get(fn)}"
    assert names.get("99_2017_smoke-paper.pdf") == SMOKE_ID, "smoke-paper id mismatch"
    print("[1] all 5 move ids + smoke id verified against filenames")

    turing = [m for m in get(f"{BASE}/library/materials")["materials"]
              if m["material_id"] == TURING_ID]
    assert turing, "turing material not found"
    assert turing[0]["filename"] == "01_1950_turing.pdf", turing[0]["filename"]
    assert not turing[0].get("collections"), f"turing already grouped: {turing[0]['collections']}"
    print("[1] 01_1950_turing.pdf verified ungrouped")

    # ---- step 2: create the new workspace -------------------------------
    r = requests.post(f"{BASE}/workspaces", json={
        "title": NEW_TITLE, "description": NEW_DESCRIPTION}, timeout=30)
    r.raise_for_status()
    new_id = r.json()["workspace"]["workspace_id"]
    print(f"[2] created {NEW_TITLE!r} -> {new_id}")

    # ---- step 3: move 5 materials (attach first, then detach) -----------
    for fn in NEW_ORDER:
        mid = MOVE[fn]
        ra = requests.post(f"{BASE}/workspaces/{new_id}/materials",
                           json={"material_id": mid}, timeout=30)
        ra.raise_for_status()
        rd = requests.delete(f"{BASE}/workspaces/{RL_PAPER}/materials/{mid}", timeout=30)
        rd.raise_for_status()
        print(f"[3] moved {fn} ({mid})")
    assert len(workspace_by_id(new_id)["tabs"]) == 5, "new workspace should hold 5"

    # ---- step 4: delete smoke-paper -------------------------------------
    r = requests.delete(f"{BASE}/materials/{SMOKE_ID}", timeout=30)
    r.raise_for_status()
    print(f"[4] deleted smoke-paper ({SMOKE_ID}): {r.json()}")

    # ---- step 5: attach turing to rl paper ------------------------------
    r = requests.post(f"{BASE}/workspaces/{RL_PAPER}/materials",
                      json={"material_id": TURING_ID}, timeout=30)
    r.raise_for_status()
    print(f"[5] attached 01_1950_turing.pdf ({TURING_ID}) to rl paper")

    # ---- step 6: reorder both -------------------------------------------
    rl_names = ordered_filenames(workspace_by_id(RL_PAPER))
    rl_order = sorted(rl_names, key=num_key)
    assert rl_order[0] == "01_1950_turing.pdf", rl_order[:3]
    rl_ids = [filename_map(workspace_by_id(RL_PAPER))[fn] for fn in rl_order]
    r = requests.put(f"{BASE}/workspaces/{RL_PAPER}/materials/order",
                     json={"material_ids": rl_ids}, timeout=30)
    r.raise_for_status()
    print(f"[6] reordered rl paper ({len(rl_ids)}): {rl_order[0]} .. {rl_order[-1]}")

    new_names = ordered_filenames(workspace_by_id(new_id))
    assert set(new_names) == set(NEW_ORDER), new_names
    new_ids = [filename_map(workspace_by_id(new_id))[fn] for fn in NEW_ORDER]
    r = requests.put(f"{BASE}/workspaces/{new_id}/materials/order",
                     json={"material_ids": new_ids}, timeout=30)
    r.raise_for_status()
    print(f"[6] reordered new workspace: {NEW_ORDER}")

    # ---- verification ---------------------------------------------------
    print("\n===== VERIFY =====")
    ws = {w["workspace_id"]: w for w in get(f"{BASE}/workspaces")["workspaces"]}
    print(f"rl paper    : {len(ws[RL_PAPER]['tabs'])} materials (expect 30)")
    print(f"强化学习课程 : {len(ws[new_id]['tabs'])} materials (expect 5)")
    print("rl paper order:")
    for fn in ordered_filenames(ws[RL_PAPER]):
        print("   ", fn)
    print("新组 order:")
    for fn in ordered_filenames(ws[new_id]):
        print("   ", fn)
    lib = get(f"{BASE}/library/materials")["materials"]
    smoke = [m for m in lib if m["material_id"] == SMOKE_ID]
    tur = [m for m in lib if m["material_id"] == TURING_ID]
    print(f"smoke-paper present: {bool(smoke)} (expect False)")
    print(f"turing collections: {[c['title'] for c in tur[0].get('collections', [])] if tur else 'MISSING'}")


if __name__ == "__main__":
    sys.exit(main())
