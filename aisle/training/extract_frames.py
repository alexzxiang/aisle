#!/usr/bin/env python3
"""
Frame extraction and cropping (10-CV-TRAINING-TRACK.md §3.3, steps 1–2).

    python3 extract_frames.py --manifest data/manifest.csv --raw data/raw \
        --out data --fps 2 --keep 45

For every clip listed in data/manifest.csv (recorded on site, §3.4):
  1. extract frames at --fps with ffmpeg into data/frames/<crossingId>/<clipStem>/;
  2. keep --keep frames per clip, biased toward state transitions: a clip's
     `transitionsS` column ("12.5;41.0") marks hand→walk / walk→countdown seconds and
     frames within ±3 s of one are kept first, the rest evenly;
  3. write the module's geometry crop — a 640×640 window centred on the frame's centre
     column and on the horizon row — to data/crops/<crossingId>/<clipStem>/ and keep
     the full frame beside it (the on-device replay uses the full frame, 10 §7).

The horizon row comes from the clip's `pitchDeg` column when it was logged (phone
tilted up ~10° → horizon sits below the frame centre) and defaults to the vertical
centre otherwise. Faces are not blurred here: drop frames with a legible bystander
face during hand correction (§3.3 step 3).

Raw video is never committed; this script only reads it.
"""
from __future__ import annotations

import argparse
import csv
import math
import shutil
import subprocess
import sys
from pathlib import Path

CROP = 640
DEFAULT_HFOV_DEG = 69.0  # iPhone main camera, landscape long edge (10 §2)


def parse_transitions(cell: str | None) -> list[float]:
    if not cell:
        return []
    out: list[float] = []
    for part in cell.replace(",", ";").split(";"):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(float(part))
        except ValueError:
            print(f"  ! ignoring transition marker {part!r}", file=sys.stderr)
    return out


def horizon_row(height: int, width: int, pitch_deg: float | None, hfov_deg: float = DEFAULT_HFOV_DEG) -> int:
    """Row index of the horizon. Pitch up moves the horizon down in the image."""
    if pitch_deg is None:
        return height // 2
    focal_px = (width / 2) / math.tan(math.radians(hfov_deg / 2))
    offset = focal_px * math.tan(math.radians(pitch_deg))
    return int(max(0, min(height - 1, height / 2 + offset)))


def crop_box(width: int, height: int, horizon: int, size: int = CROP) -> tuple[int, int, int, int]:
    """(x0, y0, x1, y1) of a size×size window centred on the centre column and the horizon row, clamped."""
    half = size // 2
    cx = width // 2
    x0 = max(0, min(width - size, cx - half))
    y0 = max(0, min(height - size, horizon - half))
    return x0, y0, x0 + size, y0 + size


def select_frames(n_frames: int, fps: float, keep: int, transitions_s: list[float], window_s: float = 3.0) -> list[int]:
    """Indices to keep: everything within ±window_s of a transition first, then evenly across the rest."""
    if n_frames <= keep:
        return list(range(n_frames))
    priority: list[int] = []
    for t in transitions_s:
        lo = max(0, int((t - window_s) * fps))
        hi = min(n_frames - 1, int((t + window_s) * fps))
        priority.extend(range(lo, hi + 1))
    chosen = sorted(set(priority))[:keep]
    remaining = keep - len(chosen)
    if remaining > 0:
        rest = [i for i in range(n_frames) if i not in set(chosen)]
        step = len(rest) / remaining
        chosen.extend(rest[int(k * step)] for k in range(remaining))
    return sorted(set(chosen))


def run_ffmpeg(src: Path, dst_dir: Path, fps: float) -> list[Path]:
    dst_dir.mkdir(parents=True, exist_ok=True)
    pattern = dst_dir / "f%05d.jpg"
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src), "-vf", f"fps={fps}", "-q:v", "2", str(pattern)]
    subprocess.run(cmd, check=True)
    return sorted(dst_dir.glob("f*.jpg"))


def crop_frames(frames: list[Path], crops_dir: Path, pitch_deg: float | None) -> int:
    try:
        import cv2  # type: ignore
    except ImportError:
        print("opencv-python-headless is required for cropping (pip install -r requirements.txt)", file=sys.stderr)
        return 0
    crops_dir.mkdir(parents=True, exist_ok=True)
    written = 0
    for f in frames:
        img = cv2.imread(str(f))
        if img is None:
            continue
        h, w = img.shape[:2]
        if w < CROP or h < CROP:
            print(f"  ! {f.name}: {w}x{h} smaller than {CROP}; skipping (capture format too small, ask Agent C)", file=sys.stderr)
            continue
        x0, y0, x1, y1 = crop_box(w, h, horizon_row(h, w, pitch_deg))
        cv2.imwrite(str(crops_dir / f.name), img[y0:y1, x0:x1])
        written += 1
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", default="data/manifest.csv")
    ap.add_argument("--raw", default="data/raw", help="root holding <crossingId>/<clip>.mp4")
    ap.add_argument("--out", default="data", help="writes <out>/frames and <out>/crops")
    ap.add_argument("--fps", type=float, default=2.0)
    ap.add_argument("--keep", type=int, default=45, help="frames kept per clip (30–60 per 10 §3.3)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if shutil.which("ffmpeg") is None and not args.dry_run:
        print("ffmpeg not found on PATH", file=sys.stderr)
        return 2

    manifest = Path(args.manifest)
    if not manifest.exists():
        print(f"{manifest} missing — fill it on site (README §3)", file=sys.stderr)
        return 2

    with manifest.open(newline="") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        print("manifest has no clips yet", file=sys.stderr)
        return 1

    total = 0
    for row in rows:
        clip = row.get("clip", "").strip()
        crossing = row.get("crossingId", "").strip() or "unknown-crossing"
        if not clip:
            continue
        src = Path(args.raw) / crossing / clip
        stem = Path(clip).stem
        frames_dir = Path(args.out) / "frames" / crossing / stem
        crops_dir = Path(args.out) / "crops" / crossing / stem
        pitch = row.get("pitchDeg", "").strip()
        pitch_deg = float(pitch) if pitch else None
        transitions = parse_transitions(row.get("transitionsS"))
        print(f"{crossing}/{clip}: transitions={transitions} pitch={pitch_deg}")
        if args.dry_run:
            continue
        if not src.exists():
            print(f"  ! missing {src}", file=sys.stderr)
            continue
        frames = run_ffmpeg(src, frames_dir, args.fps)
        keep_idx = set(select_frames(len(frames), args.fps, args.keep, transitions))
        for i, f in enumerate(frames):
            if i not in keep_idx:
                f.unlink()
        kept = sorted(frames_dir.glob("f*.jpg"))
        n = crop_frames(kept, crops_dir, pitch_deg)
        total += n
        print(f"  kept {len(kept)} frames, wrote {n} crops")
    print(f"done: {total} crops")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
