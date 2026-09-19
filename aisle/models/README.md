# models/ — CoreML weights the PerceptionModule loads

Owner: Agent C. No binary weights are committed from a build machine by hand: every
`.mlpackage` arrives as a PR from Agent D's training track (`10-CV-TRAINING-TRACK.md` §6)
with its manifest and licence entry, and Agent C merges it. This README, `manifest.json`
and `LICENSES.md` are the contract the Swift `ModelRegistry` reads; the file names below are
fixed by `04-AGENT-C-perception-indoor.md` Task 2 and `09-PERCEPTION-MODULE.md` §3, and the
registry looks them up by exactly these names (`ModelRegistry.swift`,
`cocoModelName` / `signalModelName` / `depthModelName` / `segmentationModelName`).

The Perception podspec globs `models/*.{mlpackage,mlmodelc,json}` into the pod's resources,
so a checkout without weights still builds; the engine logs the missing model, the
pipeline stage that needs it reports `unavailable` and the affected event stream stays
silent (silence, never a guess).

## Files

| File | Role | Input | Label order (index 0 first) | Source |
|---|---|---|---|---|
| `coco-yolo-nano.mlpackage` | vehicle / person detector (Tier 0, 15 fps) | RGB 640×640, letterboxed, pixels scaled 0–1 by the model, NMS embedded | 80-class COCO order (`person`=0, `bicycle`=1, `car`=2, `motorcycle`=3, `bus`=5, `truck`=7 …). The module keeps `car`, `bus`, `truck`, `motorcycle`, `bicycle`, `person`; `cart` is a heuristic label, not a class | stock Ultralytics YOLO11n (or YOLOv8n) export, `format=coreml imgsz=640 half=True nms=True` (10 §8) |
| `oiv7-yolo-nano.mlpackage` | second detector indoors (round 9): doors, handles, counters, cabinets, drawers, switches, stairs, shelves, windows, mugs, plates, eggs, milk, keys-sized things; alternates frames with COCO in INDOOR_NAV / ITEM_PICKUP / AWARE | RGB 640×640, letterboxed, NMS embedded | 601-class Open Images V7 order; the module keeps `OpenImagesLabels.kept` (VehicleTracker.swift) at score ≥ 0.35 | stock Ultralytics YOLOv8n-oiv7: `cd training && .venv/bin/python export_coreml.py --weights yolov8n-oiv7.pt --name oiv7-yolo-nano --coco && cp -R export/oiv7-yolo-nano.mlpackage ../models/` (git-ignored, ~7 MB; optional — without it COCO runs alone) |
| `coco-yolo-nano-416.mlpackage` | same detector at 416 px, loaded only if the 15 fps gate is missed | RGB 416×416, letterboxed | same COCO order | same export with `imgsz=416` |
| `ped-signal-v1.mlpackage` | pedestrian-signal detector (APPROACH_CROSSING / AT_CURB / CROSSING, 15 fps, centre band) | RGB 640×640 crop of the native-resolution centre band, letterboxed, 0–1, NMS embedded | `ped_walk`=0, `ped_hand`=1, `ped_countdown`=2 (frozen in 10 §6 and in `Detection.cls`, 01 §7) | D's fine-tune on public + local frames (10 §4–§5); a new version is a new file (`ped-signal-v2.*`), never an overwrite |
| `depth-anything-v2-small.mlpackage` | relative depth → obstacle NEAR / MID / FAR, aisle centring, end-of-aisle wall (10 fps) | model-native square input, 518 px class — **[verify]** exact size and per-frame ms on the demo phone | none (dense output, relative depth, unitless) | published CoreML conversion of Depth Anything V2 Small (Apple/Hugging Face) or a coremltools conversion; licence **[verify]** expected Apache-2.0 for the small variant |
| `walkable-seg.mlpackage` | optional: road / sidewalk / wall / building → curb-line offset (`onLateralOffset {source: 'curb'}`) | ~512×256 **[verify]** | Cityscapes-class order per its own manifest | phase-2 item, off by default (`ModelRegistry.segmentationEnabled = false`) |

Apple Vision OCR (`VNRecognizeTextRequest`, `.fast`) is a system request and has no file here.

## Manifests

Each model ships with `<name>.json` in the shape of 10 §6 (the registry reads `name`,
`arch`, `input`, `labels`, `confThreshold`; unknown fields are ignored so D can add metrics
without a native change). `manifest.json` in this directory is the index: it lists every
expected file, its status (`present` / `expected`), and the per-class thresholds the module
applies **before** the 5-of-8 vote. The module may raise a threshold from device
measurements, never lower it.

## Rules

- Compute units `.all`; the unit each model actually lands on is logged at first load and
  is visible in the DebugPanel through the native log. A model that falls to CPU is a
  phase-0 bug, not a tuning knob.
- Loaded lazily per profile and evicted when the profile no longer needs them
  (`INDOOR_NAV` never holds the signal model; `APPROACH_CROSSING` never holds OCR state).
- A new `.mlpackage` is a native change: it means a new EAS development build for the
  Windows user's phone. Batch model updates with other native changes.
- Licences: `LICENSES.md` carries a per-model and per-dataset entry; an artifact without a
  licence line does not merge.

## Status at this commit

No weights are present. `manifest.json` records every expected file as `expected`, with the
label orders, input sizes and default thresholds the Swift registry assumes. The engine
degrades per stage: no detector → no vehicle, hazard or signal events; no depth → no
obstacle or shelf-offset events (heading + pose drift still drive COURSE); OCR keeps working
because it needs no file.
