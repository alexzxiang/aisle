#!/usr/bin/env python3
"""
Training recipe (10-CV-TRAINING-TRACK.md §3.4 split + §4 recipe). Ultralytics YOLO11n
from COCO-pretrained weights, 640 px, 50 epochs, on a free Colab T4.

    # v0 — public data only (pipeline sanity: does it find any US head?)
    python3 train_yolo.py --run v0 --public data/public --no-local

    # v1 — public + local, one crossing held out (the number that decides the gate)
    python3 train_yolo.py --run v1 --public data/public --local data/crops \
        --labels data/labels --manifest data/manifest.csv --heldout crossing-forbes-01

Layout it expects (README §3):
  data/crops/<crossingId>/<clip>/<frame>.jpg        640×640 crops (extract_frames.py)
  data/labels/<crossingId>/<clip>/<frame>.txt       hand-corrected YOLO txt (vlm_label.py → corrected)
  data/public/{images,labels}/...                   public sets, already YOLO-formatted, training-only

What it does, in order:
  1. Leave-one-crossing-out split: every local frame whose crossingId == --heldout goes to
     the held-out list (data/splits/heldout-<crossingId>.txt) and never into train/val.
     Public data are training-only and never appear in held-out numbers.
  2. Class balance: counts instances per class; if the majority exceeds ~3× the minority
     it drops near-duplicate frames (consecutive frames of the same clip) from the
     majority until the ratio holds. No synthetic signal images, ever.
  3. Writes runs/<date>-<n>/dataset.yaml with the fixed label order from label_schema.json.
  4. Trains with the §4 hyper-parameters and logs per-class P/R + the confusion matrix
     (ultralytics writes results.csv and confusion_matrix.png into the run dir).
  5. Prints the run id to note in the manifest (10 §6).

Run in Colab: `!pip install -r requirements.txt` then the command above from training/.
"""
from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLASSES: list[str] = json.loads((HERE / "label_schema.json").read_text())["classes"]

# 10 §4 — the recipe. Change here, nowhere else, and note it in the changelog.
RECIPE = dict(
    model="yolo11n.pt",
    imgsz=640,
    epochs=50,
    patience=15,
    batch=32,          # drop to 16 on a CUDA OOM
    close_mosaic=10,
    scale=0.5,         # small-object bias: symbols span 8–40 px at 10–20 m
    translate=0.1,
    degrees=5,
    hsv_v=0.6,
    hsv_s=0.7,
    hsv_h=0.015,
    fliplr=0.5,
    mosaic=1.0,
)
MAJORITY_CAP = 3.0


def read_manifest(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with path.open(newline="") as fh:
        return {Path(r["clip"]).stem: r for r in csv.DictReader(fh) if r.get("clip")}


def local_frames(crops: Path, labels: Path) -> list[tuple[Path, Path, str, str]]:
    """(image, label, crossingId, clipStem) for every crop with a hand-corrected label."""
    out = []
    for img in sorted(crops.rglob("*.jpg")):
        rel = img.relative_to(crops)
        lbl = labels / rel.with_suffix(".txt")
        if not lbl.exists():
            continue  # uncorrected frames are not training data
        parts = rel.parts
        crossing = parts[0] if len(parts) >= 3 else "unknown"
        clip = parts[1] if len(parts) >= 3 else rel.parent.name
        out.append((img, lbl, crossing, clip))
    return out


def public_frames(public: Path) -> list[tuple[Path, Path]]:
    imgs = public / "images"
    lbls = public / "labels"
    out = []
    if not imgs.exists():
        return out
    for img in sorted(list(imgs.rglob("*.jpg")) + list(imgs.rglob("*.png"))):
        lbl = lbls / img.relative_to(imgs).with_suffix(".txt")
        if lbl.exists():
            out.append((img, lbl))
    return out


def count_instances(label_files: list[Path]) -> Counter:
    c: Counter = Counter()
    for lf in label_files:
        for line in lf.read_text().splitlines():
            parts = line.split()
            if parts:
                try:
                    c[int(parts[0])] += 1
                except ValueError:
                    pass
    return c


def dominant_class(lbl: Path) -> int | None:
    c = count_instances([lbl])
    return c.most_common(1)[0][0] if c else None


def balance(frames: list[tuple[Path, Path, str, str]], cap: float = MAJORITY_CAP) -> list[tuple[Path, Path, str, str]]:
    """Cap the majority class at ~cap× the minority by dropping every other consecutive frame of majority clips."""
    counts = count_instances([f[1] for f in frames])
    present = {k: v for k, v in counts.items() if v > 0}
    if len(present) < 2:
        return frames
    minority = min(present.values())
    kept = list(frames)
    for _ in range(6):
        counts = count_instances([f[1] for f in kept])
        maj_cls, maj_n = counts.most_common(1)[0]
        if maj_n <= cap * minority:
            break
        by_clip: dict[str, list[tuple[Path, Path, str, str]]] = defaultdict(list)
        for f in kept:
            if dominant_class(f[1]) == maj_cls:
                by_clip[f[3]].append(f)
        drop: set[Path] = set()
        for clip_frames in by_clip.values():
            drop.update(f[0] for f in clip_frames[1::2])  # near-duplicates: every other consecutive frame
        if not drop:
            break
        kept = [f for f in kept if f[0] not in drop]
    return kept


def link_into(run: Path, split: str, pairs: list[tuple[Path, Path]]) -> None:
    for sub in ("images", "labels"):
        (run / split / sub).mkdir(parents=True, exist_ok=True)
    for i, (img, lbl) in enumerate(pairs):
        stem = f"{i:06d}_{img.stem}"
        dst_img = run / split / "images" / f"{stem}{img.suffix}"
        dst_lbl = run / split / "labels" / f"{stem}.txt"
        try:
            dst_img.symlink_to(img.resolve())
        except OSError:
            shutil.copy2(img, dst_img)
        shutil.copy2(lbl, dst_lbl)


def next_run_dir(runs: Path, tag: str) -> Path:
    runs.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    n = 1
    while (runs / f"{today}-{n:02d}-{tag}").exists():
        n += 1
    return runs / f"{today}-{n:02d}-{tag}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--run", required=True, choices=["v0", "v1", "v2", "ship"], help="v0 public-only, v1 public+local held out, ship = all local (after v1's number is recorded)")
    ap.add_argument("--public", default="data/public")
    ap.add_argument("--local", default="data/crops")
    ap.add_argument("--labels", default="data/labels")
    ap.add_argument("--manifest", default="data/manifest.csv")
    ap.add_argument("--heldout", default=None, help="crossingId held out entirely (required for v1/v2)")
    ap.add_argument("--no-local", action="store_true")
    ap.add_argument("--val-frac", type=float, default=0.15, help="validation fraction of the training crossings, split by clip")
    ap.add_argument("--runs", default="runs")
    ap.add_argument("--epochs", type=int, default=RECIPE["epochs"])
    ap.add_argument("--batch", type=int, default=RECIPE["batch"])
    ap.add_argument("--device", default=None, help="e.g. 0 for the Colab GPU; default lets ultralytics choose")
    ap.add_argument("--dry-run", action="store_true", help="build the split and yaml, do not train")
    ap.add_argument("--seed", type=int, default=20260919)
    args = ap.parse_args()
    random.seed(args.seed)

    if args.run in ("v1", "v2") and not args.heldout:
        print("--heldout <crossingId> is required for v1/v2 (leave-one-crossing-out, 10 §3.4)", file=sys.stderr)
        return 2

    pub = public_frames(Path(args.public))
    local = [] if args.no_local else local_frames(Path(args.local), Path(args.labels))
    if not pub and not local:
        print("no training frames found (public or local)", file=sys.stderr)
        return 1

    heldout = [f for f in local if f[2] == args.heldout] if args.heldout else []
    trainable = [f for f in local if f[2] != args.heldout] if args.heldout else local
    if args.run == "ship":
        trainable = local
        heldout = []
    before = count_instances([f[1] for f in trainable])
    trainable = balance(trainable)
    after = count_instances([f[1] for f in trainable])

    # Split train/val by clip, never by frame (consecutive frames are near-duplicates).
    clips = sorted({f[3] for f in trainable})
    random.shuffle(clips)
    n_val = max(1, int(len(clips) * args.val_frac)) if len(clips) > 1 else 0
    val_clips = set(clips[:n_val])
    train_pairs = [(f[0], f[1]) for f in trainable if f[3] not in val_clips] + pub
    val_pairs = [(f[0], f[1]) for f in trainable if f[3] in val_clips]
    if not val_pairs:
        val_pairs = pub[-max(1, len(pub) // 10):] if pub else train_pairs[-1:]

    run = next_run_dir(Path(args.runs), args.run)
    run.mkdir(parents=True)
    link_into(run, "train", train_pairs)
    link_into(run, "val", val_pairs)
    if heldout:
        link_into(run, "heldout", [(f[0], f[1]) for f in heldout])
        split_file = Path("data/splits") / f"heldout-{args.heldout}.txt"
        split_file.parent.mkdir(parents=True, exist_ok=True)
        split_file.write_text("\n".join(str(f[0]) for f in heldout) + "\n")

    yaml_text = "\n".join([
        f"path: {run.resolve()}",
        "train: train/images",
        "val: val/images",
        *(["test: heldout/images"] if heldout else []),
        f"nc: {len(CLASSES)}",
        "names:",
        *[f"  {i}: {c}" for i, c in enumerate(CLASSES)],
        "",
    ])
    (run / "dataset.yaml").write_text(yaml_text)
    summary = {
        "run": run.name,
        "mode": args.run,
        "heldOutCrossing": args.heldout,
        "publicImages": len(pub),
        "localFrames": len(trainable),
        "heldOutFrames": len(heldout),
        "instancesBeforeBalance": {CLASSES[k]: v for k, v in before.items() if k < len(CLASSES)},
        "instancesAfterBalance": {CLASSES[k]: v for k, v in after.items() if k < len(CLASSES)},
        "recipe": {**RECIPE, "epochs": args.epochs, "batch": args.batch},
        "labels": CLASSES,
    }
    (run / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    if args.dry_run:
        print(f"dry run: split and yaml written to {run}")
        return 0

    try:
        from ultralytics import YOLO  # type: ignore
    except ImportError:
        print("pip install ultralytics (see requirements.txt)", file=sys.stderr)
        return 2

    model = YOLO(RECIPE["model"])
    hp = {k: v for k, v in RECIPE.items() if k not in ("model", "epochs", "batch")}
    model.train(
        data=str(run / "dataset.yaml"),
        epochs=args.epochs,
        batch=args.batch,
        project=str(run),
        name="train",
        exist_ok=True,
        seed=args.seed,
        device=args.device,
        plots=True,
        **hp,
    )
    print(f"\nrun id: {args.runs}/{run.name}  (weights: {run / 'train' / 'weights' / 'best.pt'})")
    print("next: python3 export_coreml.py --weights", run / "train" / "weights" / "best.pt", "--run", run.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
