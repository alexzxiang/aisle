#!/usr/bin/env python3
"""
Fine-tune the home/street detector on NVIDIA Brev (round 9, Stream A).

The app now runs two on-device detectors indoors: COCO nano (the 80 classic classes) and
Open Images V7 nano (`oiv7-yolo-nano`, 601 labels, of which `OpenImagesLabels.kept` in
VehicleTracker.swift uses ~110). The stock Open Images nano is weak per class because its
head is spread over 601 labels. This job narrows it to the labels the app actually keeps,
fine-tunes from the stock weights on Open Images images that contain them, and exports the
same CoreML shape the phone already loads — swap the .mlpackage, no app code changes.

    # on a Brev GPU box (an L4 or A10 is plenty for a nano model; an A100 finishes in ~1 h)
    git clone https://github.com/alexzxiang/aisle && cd aisle/aisle/training/brev
    pip install -U ultralytics fiftyone
    python3 oiv7_home.py --samples 600 --epochs 40           # ~50k images, ~30 GB download
    # → runs/oiv7-home/weights/best.pt, and export/oiv7-yolo-nano.mlpackage + .json
    # copy the .mlpackage into aisle/models/ on the Mac (scp / Brev file download), rebuild.

    python3 oiv7_home.py --samples 150 --epochs 10 --dry-run   # a 10-minute smoke test first

Budget: with $60 of credits, `--samples 600` on an A100 is about $8–12 of compute plus the
download; keep the instance's disk ≥ 100 GB. Stop the instance when the export prints.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The labels the phone keeps (OpenImagesLabels.kept, VehicleTracker.swift), in Open Images'
# own spelling. Keep this list and the Swift map in step: a label trained here but not mapped
# there is dropped on the phone; a label mapped there but absent here falls back to COCO.
KEPT_LABELS: list[str] = [
    # what a home is made of
    "Door", "Door handle", "Countertop", "Cabinetry", "Bathroom cabinet", "Filing cabinet", "Drawer", "Chest of drawers",
    "Light switch", "Stairs", "Shelf", "Bookcase", "Window", "Mirror", "Pillow", "Towel", "Paper towel", "Waste container",
    "Lamp", "Curtain", "Window blind", "Fireplace", "Ladder", "Washing machine", "Dishwasher", "Bathtub", "Shower", "Tap",
    "Plumbing fixture", "Desk", "Stool", "Nightstand", "Wardrobe", "Gas stove", "Wood-burning stove",
    # things people ask for
    "Plate", "Mug", "Coffee cup", "Kettle", "Teapot", "Tin can", "Box", "Egg (Food)", "Milk", "Bread", "Bagel", "Glasses",
    "Sunglasses", "Footwear", "Boot", "Headphones", "Watch", "Computer monitor", "Tablet computer", "Printer", "Frying pan",
    "Wok", "Cutting board", "Soap dispenser", "Candle", "Plastic bag", "Tomato", "Potato", "Fruit", "Vegetable", "Snack",
    "Cookie", "Candy", "Pen", "Coin",
    # street
    "Street light", "Traffic sign", "Parking meter", "Wheelchair", "Tree", "Palm tree",
    # COCO classes under Open Images names (the tracker merges them with COCO's own)
    "Table", "Kitchen & dining room table", "Coffee table", "Couch", "Sofa bed", "Studio couch", "Bed", "Chair", "Television",
    "Laptop", "Refrigerator", "Oven", "Microwave oven", "Sink", "Toilet", "Bottle", "Bowl", "Houseplant", "Flowerpot", "Book",
    "Clock", "Wall clock", "Alarm clock", "Dog", "Cat", "Backpack", "Handbag", "Suitcase", "Umbrella", "Traffic light",
    "Stop sign", "Fire hydrant", "Bench", "Banana", "Apple", "Orange", "Sandwich", "Submarine sandwich", "Pizza", "Broccoli",
    "Carrot", "Cake", "Donut", "Wine glass", "Fork", "Knife", "Spoon", "Remote control", "Computer keyboard", "Mobile phone",
    "Toaster", "Vase", "Scissors", "Teddy bear", "Toothbrush", "Hair dryer", "Computer mouse", "Tie", "Person", "Man",
    "Woman", "Boy", "Girl", "Car", "Taxi", "Van", "Bus", "Truck", "Motorcycle", "Bicycle", "Cart",
]


def download(samples_per_class: int, out: Path) -> tuple[Path, Path]:
    """Open Images V7 boxes for the kept labels only, as a YOLO dataset (train + validation)."""
    import fiftyone as fo
    import fiftyone.zoo as foz

    splits: dict[str, Path] = {}
    for split, cap in (("train", samples_per_class), ("validation", max(20, samples_per_class // 10))):
        ds = foz.load_zoo_dataset(
            "open-images-v7",
            split=split,
            label_types=["detections"],
            classes=KEPT_LABELS,
            only_matching=True,          # drop boxes of labels we do not keep
            max_samples=cap * len(KEPT_LABELS),
            shuffle=True,
            seed=7,
            dataset_name=f"oiv7-home-{split}",
        )
        export_dir = out / split
        # The zoo names the box field "detections" (older builds: "ground_truth"); take whichever holds Detections.
        field = next((n for n, f in ds.get_field_schema().items() if getattr(getattr(f, "document_type", None), "__name__", "") == "Detections"), "detections")
        ds.export(export_dir=str(export_dir), dataset_type=fo.types.YOLOv5Dataset, label_field=field, classes=KEPT_LABELS, split=split)
        splits[split] = export_dir
        print(f"{split}: {len(ds)} images → {export_dir}")
    return splits["train"], splits["validation"]


def write_yaml(train_dir: Path, val_dir: Path, out: Path) -> Path:
    yaml = out / "oiv7-home.yaml"
    names = "\n".join(f"  {i}: {n}" for i, n in enumerate(KEPT_LABELS))
    yaml.write_text(f"path: {out}\ntrain: {train_dir / 'images' / 'train'}\nval: {val_dir / 'images' / 'validation'}\nnames:\n{names}\n")
    return yaml


def train(yaml: Path, epochs: int, batch: int, dry_run: bool) -> Path:
    from ultralytics import YOLO

    model = YOLO("yolov8n-oiv7.pt")        # already knows these labels: this is a narrowing, not a cold start
    run = model.train(
        data=str(yaml), epochs=epochs, imgsz=640, batch=batch, project=str(HERE / "runs"), name="oiv7-home", exist_ok=True,
        pretrained=True, optimizer="AdamW", lr0=0.002, cos_lr=True, close_mosaic=5, patience=10,
        fraction=0.1 if dry_run else 1.0, plots=False, verbose=True,
    )
    best = Path(run.save_dir) / "weights" / "best.pt"
    print(f"best weights → {best}")
    return best


def export(best: Path) -> None:
    from ultralytics import YOLO

    model = YOLO(str(best))
    pkg = Path(model.export(format="coreml", imgsz=640, half=True, nms=True))
    out_dir = HERE / "export"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / "oiv7-yolo-nano.mlpackage"
    if dest.exists():
        shutil.rmtree(dest)
    shutil.move(str(pkg), str(dest))
    labels = [model.names[i] for i in sorted(model.names)]
    manifest = {
        "name": "oiv7-yolo-nano", "arch": "yolov8n-oiv7-home", "runId": "training/brev/runs/oiv7-home",
        "exportedOn": date.today().isoformat(),
        "input": {"width": 640, "height": 640, "letterbox": True, "colour": "RGB", "scale": "0-1"},
        "labels": labels, "nms": {"embedded": True, "iouThreshold": 0.5}, "licences": ["training/LICENSES.md"],
        "note": "Open Images V7 nano narrowed to the labels the app keeps; same names as the stock export, so the Swift map is unchanged.",
    }
    (out_dir / "oiv7-yolo-nano.json").write_text(json.dumps(manifest, indent=1))
    print(f"coreml → {dest}\nmanifest → {out_dir / 'oiv7-yolo-nano.json'}")
    print("copy the .mlpackage and .json into aisle/models/ on the Mac and run: npm run ios:device -- --clean")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=600, help="training images per label (cap; Open Images has fewer for rare labels)")
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch", type=int, default=64, help="64 fits an A100/L4; use 32 on a T4")
    ap.add_argument("--data", type=Path, default=HERE / "data", help="where the dataset lands (needs ~30 GB for --samples 600)")
    ap.add_argument("--dry-run", action="store_true", help="a tenth of the images, to check the pipeline end to end")
    ap.add_argument("--skip-download", action="store_true", help="the dataset is already under --data")
    args = ap.parse_args()

    args.data.mkdir(parents=True, exist_ok=True)
    if args.skip_download:
        train_dir, val_dir = args.data / "train", args.data / "validation"
    else:
        train_dir, val_dir = download(args.samples, args.data)
    yaml = write_yaml(train_dir, val_dir, args.data)
    best = train(yaml, args.epochs, args.batch, args.dry_run)
    export(best)
    return 0


if __name__ == "__main__":
    sys.exit(main())
