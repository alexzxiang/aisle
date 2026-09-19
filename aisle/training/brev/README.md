# Brev jobs (round 9)

`$60` of NVIDIA Brev credit buys more than one of these. Each script is self-contained:
clone the repo on the box, `pip install -U ultralytics fiftyone`, run, copy the export down.

| Script | What it makes | Cost (A100) | Why |
|---|---|---|---|
| `oiv7_home.py` | `oiv7-yolo-nano.mlpackage` narrowed to the ~110 Open Images labels the phone keeps | ~$10 + a 30 GB download | The stock 601-label nano is the weak link indoors (doors, handles, counters, drawers). Same label names, so the Swift map and the app do not change: drop the package into `models/` and rebuild. |

Steps on Brev: create a GPU instance (L4 / A10 fine, A100 fastest; disk ≥ 100 GB) → open its
terminal → `git clone https://github.com/alexzxiang/aisle && cd aisle/aisle/training/brev` →
`pip install -U ultralytics fiftyone` → `python3 oiv7_home.py --samples 150 --epochs 10 --dry-run`
(ten minutes, proves the pipeline) → `python3 oiv7_home.py --samples 600 --epochs 40` → download
`export/oiv7-yolo-nano.mlpackage` and `.json` to the Mac's `aisle/models/` → `npm run ios:device -- --clean`.
Stop the instance when the export line prints.

Not on Brev: the CoreML export itself needs no GPU and runs on the Mac (`training/.venv`);
Brev is for the training epochs.
