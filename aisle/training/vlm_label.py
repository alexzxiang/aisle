#!/usr/bin/env python3
"""
VLM first-pass labelling (10-CV-TRAINING-TRACK.md §3.3 step 4). Labelling, not runtime.

    ANTHROPIC_API_KEY=... python3 vlm_label.py --crops data/crops --out data/labels_vlm

Sends every 640×640 crop to Claude Haiku 4.5 with the strict schema in
label_schema.json (`vlm_first_pass`) as `output_config.format` and writes:
  - data/labels_vlm/<crossingId>/<clip>/<frame>.txt   YOLO txt (class x y w h), the input
    to hand correction (step 5) — nobody trains on these uncorrected;
  - data/labels_vlm/<crossingId>/<clip>/<frame>.json  the full structured answer (unlit,
    perpendicularHeadVisible, offPhaseSuspected, confidences) for the manifest attributes.

Expect the model to be right about class and wrong about box tightness (10 §3.3).
Frames the model flags `offPhaseSuspected` get an empty txt plus a `.skip` marker so the
labeller reviews them against their neighbours instead of treating them as negatives.

Runs from this machine with the training key in the environment; this is D's Colab /
laptop script, not app code, and the key never goes near the phone. Cost: cents per
hundred frames on Haiku. Use --model to switch (e.g. claude-opus-5 for a harder batch).
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMA_FILE = HERE / "label_schema.json"
DEFAULT_MODEL = "claude-haiku-4-5"  # 10 §3.3 names Haiku 4.5 for the first pass


def load_schema() -> dict:
    with SCHEMA_FILE.open() as fh:
        return json.load(fh)


def system_prompt(schema: dict) -> str:
    defs = schema["class_definitions"]
    lines = [
        "You label pedestrian-signal heads in 640x640 crops from a phone camera at a US crossing.",
        "Return only the JSON object the schema allows. Box coordinates are normalized 0..1 in the crop,",
        "centre x, centre y, width, height. Box the lit lens face only, never the housing or the pole.",
        "Class definitions (verbatim from the training track):",
    ]
    for cls in schema["classes"]:
        lines.append(f"- {cls}: {defs[cls]}")
    lines.append(f"- none: {defs['none']}")
    lines.append(schema["label_every_head"])
    lines.append("Vehicle traffic lights are never pedestrian lenses. When unsure of the class, lower the confidence rather than omit the box.")
    return "\n".join(lines)


def to_yolo_lines(answer: dict, classes: list[str]) -> list[str]:
    out: list[str] = []
    for b in answer.get("boxes", []):
        cls = b.get("cls")
        if cls not in classes:
            continue
        idx = classes.index(cls)
        x, y, w, h = (float(b.get(k, 0)) for k in ("x", "y", "w", "h"))
        if w <= 0 or h <= 0:
            continue
        out.append(f"{idx} {x:.6f} {y:.6f} {w:.6f} {h:.6f}")
    return out


def label_one(client, model: str, system: str, schema: dict, jpeg: Path, max_tokens: int = 600) -> dict:
    data = base64.standard_b64encode(jpeg.read_bytes()).decode("ascii")
    resp = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                {"type": "text", "text": f"Label this crop. File: {jpeg.name}"},
            ],
        }],
        output_config={"format": {"type": "json_schema", "schema": schema["vlm_first_pass"]}},
    )
    if resp.stop_reason != "end_turn":
        raise RuntimeError(f"stop_reason={resp.stop_reason}")
    text = "".join(block.text for block in resp.content if getattr(block, "type", "") == "text")
    return json.loads(text)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crops", default="data/crops")
    ap.add_argument("--out", default="data/labels_vlm")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--limit", type=int, default=0, help="stop after N crops (smoke test)")
    ap.add_argument("--overwrite", action="store_true")
    ap.add_argument("--sleep", type=float, default=0.0, help="seconds between calls if rate-limited")
    args = ap.parse_args()

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY is not set (training key, from your own env — never the app)", file=sys.stderr)
        return 2
    try:
        import anthropic  # type: ignore
    except ImportError:
        print("pip install anthropic (see requirements.txt)", file=sys.stderr)
        return 2

    schema = load_schema()
    classes: list[str] = schema["classes"]
    system = system_prompt(schema)
    client = anthropic.Anthropic(max_retries=2)

    crops = sorted(Path(args.crops).rglob("*.jpg"))
    if not crops:
        print(f"no crops under {args.crops}; run extract_frames.py first", file=sys.stderr)
        return 1
    done = 0
    failed = 0
    for jpeg in crops:
        rel = jpeg.relative_to(args.crops)
        txt = Path(args.out) / rel.with_suffix(".txt")
        if txt.exists() and not args.overwrite:
            continue
        txt.parent.mkdir(parents=True, exist_ok=True)
        try:
            answer = label_one(client, args.model, system, schema, jpeg)
        except Exception as e:  # noqa: BLE001 — one bad frame must not stop the batch
            failed += 1
            print(f"  ! {rel}: {e}", file=sys.stderr)
            continue
        lines = [] if answer.get("offPhaseSuspected") else to_yolo_lines(answer, classes)
        txt.write_text("\n".join(lines) + ("\n" if lines else ""))
        txt.with_suffix(".json").write_text(json.dumps(answer, indent=1))
        skip = txt.with_suffix(".skip")
        if answer.get("offPhaseSuspected"):
            skip.write_text("review against neighbouring frames; LED off-phase suspected\n")
        elif skip.exists():
            skip.unlink()
        done += 1
        if done % 25 == 0:
            print(f"{done} labelled, {failed} failed")
        if args.limit and done >= args.limit:
            break
        if args.sleep:
            time.sleep(args.sleep)
    print(f"done: {done} labelled, {failed} failed → {args.out}. Hand-correct every frame before training.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
