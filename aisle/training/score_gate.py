#!/usr/bin/env python3
"""
Gate scoring (10-CV-TRAINING-TRACK.md §1 gates, §7 definitions). Agent C runs the
held-out footage through the module's own crop + gate + 5-of-8 vote; D scores it here.

Two levels:

  A. Per-frame detector — predictions vs hand labels on held-out crops, IoU ≥ 0.5,
     binned by distanceM and timeOfDay from the manifest:
        python3 score_gate.py detector --pred runs/<run>/heldout_pred --labels data/labels \
            --manifest data/manifest.csv --heldout crossing-forbes-01

     <pred> holds YOLO txt with a trailing confidence column (`cls x y w h conf`), one
     file per held-out crop, named like the label file (ultralytics `save_txt save_conf`).

  B. Emitted states — what the user would hear, after the gate and the vote:
        python3 score_gate.py states --emitted eval/emitted-<crossingId>.csv \
            --truth eval/truth-<crossingId>.csv --out eval/ped-signal-v1-gate.json

     emitted csv columns: clip,tS,state,fresh          (from the module's debug replay, 09 §10)
     truth   csv columns: clip,tS,state,distanceM,targetVisible,perpVisible
                                                        (state = truth of the TARGET head:
                                                         WALK|DONT_WALK|COUNTDOWN|UNLIT|NONE)
     Metrics (10 §7.2):
       falseWalkPrecision   emitted WALK whose target truth is WALK / all emitted WALK
                            (hand, countdown, unlit and target-not-visible all count false)
       recallWalk / recallHand   GT spans ≥ 2 s (10–20 m) during which the matching state
                            was emitted at least once within 1 s of onset
       perpConfusion        emitted non-UNKNOWN frames on targetVisible=false & perpVisible=true
                            clips / all frames in those clips
       onsetCorrectness     each DONT_WALK→WALK truth transition yields exactly one fresh:true;
                            a clip that starts mid-WALK yields fresh:false first

Prints the gate table with PASS/FAIL against > 0.95 / > 0.80 / < 0.02 and writes JSON that
export_coreml.py's manifest and the report (eval/ped-signal-v1-report.md) are filled from.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLASSES: list[str] = json.loads((HERE / "label_schema.json").read_text())["classes"]
GATES = {"falseWalkPrecision": (">", 0.95), "recallWalk10to20m": (">", 0.80), "recallHand10to20m": (">", 0.80), "perpConfusionAfterGate": ("<", 0.02)}
IOU_MIN = 0.5
SPAN_MIN_S = 2.0
ONSET_WINDOW_S = 1.0
NEAR_BIN = ("10", "15", "20")  # manifest distanceM values that count as "10–20 m"


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def read_csv(path: Path) -> list[dict]:
    with path.open(newline="") as fh:
        return list(csv.DictReader(fh))


def truthy(v: str | None) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "y")


def iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax0, ay0, ax1, ay1 = a[0] - a[2] / 2, a[1] - a[3] / 2, a[0] + a[2] / 2, a[1] + a[3] / 2
    bx0, by0, bx1, by1 = b[0] - b[2] / 2, b[1] - b[3] / 2, b[0] + b[2] / 2, b[1] + b[3] / 2
    iw = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    ih = max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def read_boxes(path: Path, with_conf: bool) -> list[tuple[int, tuple[float, float, float, float], float]]:
    out = []
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        p = line.split()
        if len(p) < 5:
            continue
        cls = int(p[0])
        box = (float(p[1]), float(p[2]), float(p[3]), float(p[4]))
        conf = float(p[5]) if with_conf and len(p) > 5 else 1.0
        out.append((cls, box, conf))
    return out


def verdict(name: str, value: float | None) -> str:
    if value is None or name not in GATES:
        return "n/a"
    op, thr = GATES[name]
    ok = value > thr if op == ">" else value < thr
    return "PASS" if ok else "FAIL"


# ---------------------------------------------------------------------------
# A. Per-frame detector
# ---------------------------------------------------------------------------

def score_detector(pred_dir: Path, labels_dir: Path, manifest_rows: list[dict], heldout: str | None, conf_min: float) -> dict:
    clip_attrs = {Path(r["clip"]).stem: r for r in manifest_rows if r.get("clip")}
    bins: dict[tuple[str, str, str], dict[str, int]] = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})
    frames = 0
    for lbl in sorted(labels_dir.rglob("*.txt")):
        rel = lbl.relative_to(labels_dir)
        crossing = rel.parts[0] if len(rel.parts) >= 3 else "unknown"
        if heldout and crossing != heldout:
            continue
        clip = rel.parts[1] if len(rel.parts) >= 3 else rel.parent.name
        attrs = clip_attrs.get(clip, {})
        dist = attrs.get("distanceM", "?")
        tod = attrs.get("timeOfDay", "?")
        gt = read_boxes(lbl, with_conf=False)
        pred = [p for p in read_boxes(pred_dir / rel, with_conf=True) if p[2] >= conf_min]
        frames += 1
        used: set[int] = set()
        for pc, pb, _ in sorted(pred, key=lambda p: -p[2]):
            best, best_i = 0.0, -1
            for i, (gc, gb, _) in enumerate(gt):
                if i in used or gc != pc:
                    continue
                v = iou(pb, gb)
                if v > best:
                    best, best_i = v, i
            key = (CLASSES[pc] if pc < len(CLASSES) else str(pc), dist, tod)
            if best >= IOU_MIN:
                used.add(best_i)
                bins[key]["tp"] += 1
            else:
                bins[key]["fp"] += 1
        for i, (gc, _, _) in enumerate(gt):
            if i not in used:
                bins[(CLASSES[gc] if gc < len(CLASSES) else str(gc), dist, tod)]["fn"] += 1

    rows = []
    for (cls, dist, tod), c in sorted(bins.items()):
        p = c["tp"] / (c["tp"] + c["fp"]) if c["tp"] + c["fp"] else None
        r = c["tp"] / (c["tp"] + c["fn"]) if c["tp"] + c["fn"] else None
        rows.append({"class": cls, "distanceM": dist, "timeOfDay": tod, **c, "precision": p, "recall": r})
    return {"frames": frames, "iouMin": IOU_MIN, "confMin": conf_min, "bins": rows}


# ---------------------------------------------------------------------------
# B. Emitted states after the gate
# ---------------------------------------------------------------------------

def spans(rows: list[dict], state: str) -> list[tuple[str, float, float, str]]:
    """(clip, startS, endS, distanceM) for maximal runs of `state` in the truth rows, per clip."""
    out = []
    by_clip: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_clip[r["clip"]].append(r)
    for clip, rs in by_clip.items():
        rs.sort(key=lambda r: float(r["tS"]))
        start = None
        dist = "?"
        for i, r in enumerate(rs):
            is_state = r["state"] == state
            if is_state and start is None:
                start, dist = float(r["tS"]), r.get("distanceM", "?")
            if start is not None and (not is_state or i == len(rs) - 1):
                end = float(r["tS"]) if not is_state else float(r["tS"])
                out.append((clip, start, end, dist))
                start = None
    return out


def nearest_truth(truth_by_clip: dict[str, list[dict]], clip: str, t: float) -> dict | None:
    rs = truth_by_clip.get(clip)
    if not rs:
        return None
    return min(rs, key=lambda r: abs(float(r["tS"]) - t))


def score_states(emitted: list[dict], truth: list[dict]) -> dict:
    truth_by_clip: dict[str, list[dict]] = defaultdict(list)
    for r in truth:
        truth_by_clip[r["clip"]].append(r)
    emitted_by_clip: dict[str, list[dict]] = defaultdict(list)
    for r in emitted:
        emitted_by_clip[r["clip"]].append(r)
    for rs in emitted_by_clip.values():
        rs.sort(key=lambda r: float(r["tS"]))

    # false-WALK precision
    walk_emitted = [r for r in emitted if r["state"] == "WALK"]
    walk_true = 0
    for r in walk_emitted:
        t = nearest_truth(truth_by_clip, r["clip"], float(r["tS"]))
        if t and t["state"] == "WALK" and truthy(t.get("targetVisible", "true")):
            walk_true += 1
    fwp = walk_true / len(walk_emitted) if walk_emitted else None

    # recall on ≥ 2 s spans at 10–20 m: matching state emitted within 1 s of onset
    def recall_for(truth_state: str, emitted_state: str) -> tuple[float | None, int]:
        cand = [s for s in spans(truth, truth_state) if s[2] - s[1] >= SPAN_MIN_S and str(s[3]) in NEAR_BIN]
        hit = 0
        for clip, s0, _, _ in cand:
            if any(e["state"] == emitted_state and s0 <= float(e["tS"]) <= s0 + ONSET_WINDOW_S for e in emitted_by_clip.get(clip, [])):
                hit += 1
        return (hit / len(cand) if cand else None), len(cand)

    r_walk, n_walk = recall_for("WALK", "WALK")
    r_hand, n_hand = recall_for("DONT_WALK", "DONT_WALK")

    # parallel-signal confusion
    perp_clips = {r["clip"] for r in truth if not truthy(r.get("targetVisible", "true")) and truthy(r.get("perpVisible", "false"))}
    perp_frames = [e for e in emitted if e["clip"] in perp_clips]
    perp_bad = sum(1 for e in perp_frames if e["state"] != "UNKNOWN")
    perp = perp_bad / len(perp_frames) if perp_frames else None

    # onset correctness
    onsets = 0
    onsets_ok = 0
    mid_walk_clips = 0
    mid_walk_ok = 0
    for clip, rs in truth_by_clip.items():
        rs.sort(key=lambda r: float(r["tS"]))
        em = emitted_by_clip.get(clip, [])
        if rs and rs[0]["state"] == "WALK":
            mid_walk_clips += 1
            first_walk = next((e for e in em if e["state"] == "WALK"), None)
            if first_walk and not truthy(first_walk.get("fresh")):
                mid_walk_ok += 1
        for a, b in zip(rs, rs[1:]):
            if a["state"] == "DONT_WALK" and b["state"] == "WALK":
                onsets += 1
                t0 = float(b["tS"])
                fresh = [e for e in em if e["state"] == "WALK" and truthy(e.get("fresh")) and t0 - 0.5 <= float(e["tS"]) <= t0 + 3.0]
                if len(fresh) == 1:
                    onsets_ok += 1

    metrics = {
        "falseWalkPrecision": fwp,
        "recallWalk10to20m": r_walk,
        "recallHand10to20m": r_hand,
        "perpConfusionAfterGate": perp,
    }
    return {
        "metrics": metrics,
        "gates": {k: verdict(k, v) for k, v in metrics.items()},
        "counts": {"emittedWalk": len(walk_emitted), "walkSpans": n_walk, "handSpans": n_hand, "perpFrames": len(perp_frames),
                   "onsets": onsets, "onsetsWithOneFresh": onsets_ok, "midWalkClips": mid_walk_clips, "midWalkFreshFalse": mid_walk_ok},
        "rung": "1 (on-device model)" if all(v == "PASS" for v in (verdict("falseWalkPrecision", fwp), verdict("perpConfusionAfterGate", perp))) else "2 (Sonnet curb crop) — see 10 §9",
    }


def print_table(res: dict) -> None:
    print(f"{'metric':<28}{'value':>10}  gate")
    for k, v in res["metrics"].items():
        op, thr = GATES[k]
        val = "n/a" if v is None else f"{v:.3f}"
        print(f"{k:<28}{val:>10}  {op} {thr:.2f}  {res['gates'][k]}")
    print("counts:", json.dumps(res["counts"]))
    print("rung:", res["rung"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("detector")
    d.add_argument("--pred", required=True)
    d.add_argument("--labels", default="data/labels")
    d.add_argument("--manifest", default="data/manifest.csv")
    d.add_argument("--heldout", default=None)
    d.add_argument("--conf", type=float, default=0.25)
    d.add_argument("--out", default=None)
    s = sub.add_parser("states")
    s.add_argument("--emitted", required=True)
    s.add_argument("--truth", required=True)
    s.add_argument("--out", default=None)
    args = ap.parse_args()

    if args.cmd == "detector":
        rows = read_csv(Path(args.manifest)) if Path(args.manifest).exists() else []
        res = score_detector(Path(args.pred), Path(args.labels), rows, args.heldout, args.conf)
        for b in res["bins"]:
            p = "n/a" if b["precision"] is None else f"{b['precision']:.3f}"
            r = "n/a" if b["recall"] is None else f"{b['recall']:.3f}"
            print(f"{b['class']:<14}{b['distanceM']:>5} m  {b['timeOfDay']:<10} P={p} R={r} (tp {b['tp']} fp {b['fp']} fn {b['fn']})")
        print(f"{res['frames']} frames scored")
    else:
        res = score_states(read_csv(Path(args.emitted)), read_csv(Path(args.truth)))
        print_table(res)
    if args.out:
        Path(args.out).write_text(json.dumps(res, indent=1) + "\n")
        print(f"→ {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
