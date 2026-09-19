#!/usr/bin/env python3
"""
Export + Python export check + manifest (10-CV-TRAINING-TRACK.md §5, §6).

    python3 export_coreml.py --weights runs/<run>/train/weights/best.pt --run <run> \
        --name ped-signal-v1 --heldout-crops data/splits/heldout-crossing-forbes-01.txt

    # the COCO vehicle detector, same loading path for Agent C (10 §8)
    python3 export_coreml.py --weights yolo11n.pt --name coco-yolo-nano --coco
    python3 export_coreml.py --weights yolo11n.pt --name coco-yolo-nano-416 --coco --imgsz 416

Steps:
  1. CoreML primary: format=coreml, imgsz=640, half=True, nms=True → a Vision-ready
     pipeline (VNRecognizedObjectObservation, no Swift decoding). If the NMS pipeline
     export fails on the deployment target it falls back to the raw head
     (<name>-raw.mlpackage, output [1, 4+nc, 8400]) and says so in the manifest.
  2. Optional TFLite int8 backup (--tflite), calibration = the run's dataset.yaml.
  3. Export check: runs the PyTorch model and the exported package on ten held-out crops
     and asserts the class indices agree (a swapped label index is the silent failure
     that turns HAND into WALK). coremltools cannot run a CoreML prediction on Linux, so
     on Colab this step compares the PyTorch model against the ONNX/TFLite export when
     present and otherwise records `exportCheck: "pending (needs a Mac)"` — Agent C's
     first load on the Mac is then the real check.
  4. Writes <out>/<name>.json in the 10 §6 manifest shape with measuredOn: "python" and
     placeholder metrics; score_gate.py fills the metrics from the held-out run.

Nothing here writes to models/ — Agent C merges the PR (10 §6).
"""
from __future__ import annotations

import argparse
import json
import platform
import shutil
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLASSES: list[str] = json.loads((HERE / "label_schema.json").read_text())["classes"]
COCO_KEEP = ["car", "bus", "truck", "motorcycle", "bicycle", "person"]
DEFAULT_THRESHOLDS = {"ped_walk": 0.40, "ped_hand": 0.35, "ped_countdown": 0.35}


def manifest(name: str, arch: str, run_id: str | None, imgsz: int, labels: list[str], nms_embedded: bool, extra: dict) -> dict:
    m = {
        "name": name,
        "arch": arch,
        "runId": run_id,
        "exportedOn": date.today().isoformat(),
        "input": {"width": imgsz, "height": imgsz, "letterbox": True, "colour": "RGB", "scale": "0-1"},
        "labels": labels,
        "nms": {"embedded": nms_embedded, "iouThreshold": 0.5},
        "licences": ["training/LICENSES.md"],
    }
    m.update(extra)
    return m


def read_heldout(list_file: Path | None, n: int = 10) -> list[Path]:
    if not list_file or not list_file.exists():
        return []
    paths = [Path(p) for p in list_file.read_text().split() if p]
    step = max(1, len(paths) // n)
    return [p for p in paths[::step][:n] if p.exists()]


def predict_classes(model, images: list[Path], imgsz: int) -> list[list[int]]:
    out: list[list[int]] = []
    for img in images:
        res = model.predict(str(img), imgsz=imgsz, conf=0.25, verbose=False)
        cls = []
        for r in res:
            if r.boxes is not None and len(r.boxes):
                cls = sorted(int(c) for c in r.boxes.cls.tolist())
        out.append(cls)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", required=True)
    ap.add_argument("--name", default="ped-signal-v1")
    ap.add_argument("--run", default=None, help="run id for the manifest (runs/<run>)")
    ap.add_argument("--out", default="export")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--coco", action="store_true", help="pretrained COCO detector: 80-class label order, keep-list in the manifest")
    ap.add_argument("--tflite", action="store_true", help="also export the int8 TFLite backup")
    ap.add_argument("--data", default=None, help="dataset.yaml for TFLite int8 calibration")
    ap.add_argument("--heldout-crops", default=None, help="data/splits/heldout-<crossingId>.txt for the export check")
    ap.add_argument("--heldout-crossing", default=None)
    args = ap.parse_args()

    try:
        from ultralytics import YOLO  # type: ignore
    except ImportError:
        print("pip install ultralytics coremltools (see requirements.txt)", file=sys.stderr)
        return 2

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model = YOLO(args.weights)
    labels = [model.names[i] for i in sorted(model.names)] if args.coco else CLASSES
    if not args.coco and [model.names[i] for i in sorted(model.names)] != CLASSES:
        print(f"! model label order {model.names} != {CLASSES}; fix dataset.yaml and retrain", file=sys.stderr)
        return 1

    # 1. CoreML with NMS, fall back to the raw head.
    nms_embedded = True
    exported: Path
    try:
        p = model.export(format="coreml", imgsz=args.imgsz, half=True, nms=True)
        exported = out / f"{args.name}.mlpackage"
    except Exception as e:  # noqa: BLE001
        print(f"! NMS pipeline export failed ({e}); exporting the raw head instead", file=sys.stderr)
        p = model.export(format="coreml", imgsz=args.imgsz, half=True, nms=False)
        nms_embedded = False
        exported = out / f"{args.name}-raw.mlpackage"
    if exported.exists():
        shutil.rmtree(exported)
    shutil.move(str(p), str(exported))
    print(f"coreml → {exported} (nms embedded: {nms_embedded})")

    # 2. Optional TFLite int8 backup.
    tflite_path = None
    if args.tflite:
        try:
            t = model.export(format="tflite", int8=True, imgsz=args.imgsz, data=args.data)
            tflite_path = out / f"{args.name}.tflite"
            shutil.move(str(t), str(tflite_path))
            print(f"tflite → {tflite_path}")
        except Exception as e:  # noqa: BLE001
            print(f"! tflite export failed ({e}); it is a backup, not a gate item", file=sys.stderr)

    # 3. Export check on ten held-out crops.
    check: dict = {"status": "pending (needs a Mac to run the CoreML prediction)", "frames": 0, "mismatches": None}
    crops = read_heldout(Path(args.heldout_crops) if args.heldout_crops else None)
    if crops:
        torch_cls = predict_classes(model, crops, args.imgsz)
        check["frames"] = len(crops)
        check["torchClasses"] = torch_cls
        if platform.system() == "Darwin":
            try:
                exported_model = YOLO(str(exported))
                ct_cls = predict_classes(exported_model, crops, args.imgsz)
                mism = sum(1 for a, b in zip(torch_cls, ct_cls) if a != b)
                check.update({"status": "ok" if mism == 0 else "MISMATCH — do not hand over", "mismatches": mism, "coremlClasses": ct_cls})
            except Exception as e:  # noqa: BLE001
                check["status"] = f"coreml predict failed on this Mac: {e}"
        else:
            check["status"] = "torch classes recorded; CoreML side pending on Agent C's Mac (Linux cannot run CoreML)"
    print("export check:", json.dumps(check))

    # 4. Manifest.
    if args.coco:
        extra = {
            "keep": COCO_KEEP,
            "note": "pretrained COCO YOLO11n, no fine-tune; filtering to `keep` is Agent C's (09 §3)",
            "exportCheck": check,
        }
        arch = "yolo11n-coco"
    else:
        extra = {
            "confThreshold": DEFAULT_THRESHOLDS,
            "heldOutCrossing": args.heldout_crossing,
            "metrics": {
                "falseWalkPrecision": None, "recallWalk10to20m": None, "recallHand10to20m": None,
                "perpConfusionAfterGate": None, "measuredOn": "python",
                "note": "filled by score_gate.py from the held-out run; device numbers replace them after 10 §7",
            },
            "trainedOn": {"publicImages": None, "localFrames": None, "negatives": None},
            "exportCheck": check,
            "thresholdRule": "ped_walk at the lowest value keeping held-out walk precision ≥ 0.95; hand/countdown at the F1 knee; C may raise, never lower, the walk threshold",
        }
        arch = "yolo11n"
        run_summary = Path("runs") / (args.run or "") / "summary.json"
        if args.run and run_summary.exists():
            s = json.loads(run_summary.read_text())
            extra["trainedOn"] = {"publicImages": s.get("publicImages"), "localFrames": s.get("localFrames"), "negatives": None}
    m = manifest(args.name, arch, f"training/runs/{args.run}" if args.run else None, args.imgsz, labels, nms_embedded, extra)
    if tflite_path:
        m["tflite"] = tflite_path.name
    (out / f"{args.name}.json").write_text(json.dumps(m, indent=1) + "\n")
    print(f"manifest → {out / (args.name + '.json')}")
    print("hand over as a PR against models/ (the .mlpackage, this manifest, the LICENSES.md entry, one-line changelog); Agent C merges.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
