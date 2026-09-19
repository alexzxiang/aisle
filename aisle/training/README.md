# `training/` — the pedestrian-signal detector (Agent D runs it, Agent C integrates)

The one model in Aisle that is trained rather than downloaded, and the one whose mistake
hurts most: it decides whether the app says "Walk signal on". Procedure and rationale are in
`10-CV-TRAINING-TRACK.md`; this file is that procedure in runnable order. Class names are
`Detection.cls` from `01-SHARED-CONTRACTS.md` §7; the consumer is `09-PERCEPTION-MODULE.md`
§3 / §5.1. Nothing here writes to `models/` — every artifact crosses as a PR Agent C merges.

Honesty budget, said out loud in the report and the pitch: OKO trained on > 150 000 images;
this trains on hundreds to low thousands from two or three crossings. That is why the module's
geometric gate, the 5-of-8 vote, the onset rule and the fallback ladder exist.

## Gates (10 §1) — measured on held-out local frames, device numbers

| Metric | Gate |
|---|---|
| False-WALK precision (emitted WALK states that are truly WALK) | > 95 % |
| WALK and HAND recall at 10–20 m | > 80 % |
| Parallel-signal confusion after the gate | < 2 % |
| On-device throughput with COCO + depth running | ≥ 15 fps |

Judged at **+14 h from integration start**. Miss it → the crossing beat moves down the ladder
(10 §9); tell the pitch owner within the hour. Never ship a model whose WALK precision was not
measured.

## Layout

```
training/
  README.md                this file
  LICENSES.md              every dataset and framework licence, with dates (fill BEFORE downloading)
  requirements.txt         Colab / venv
  label_schema.json        fixed class order + the VLM first-pass schema + class definitions
  extract_frames.py        ffmpeg 2 fps → transition-biased selection → 640×640 centre-band crops
  vlm_label.py             Claude Haiku 4.5 first pass → YOLO txt (to be hand-corrected)
  train_yolo.py            leave-one-crossing-out split, class balance, YOLO11n recipe
  export_coreml.py         CoreML (nms=True) + raw fallback + TFLite backup + export check + manifest
  score_gate.py            the §7 metrics from held-out predictions / emitted states
  eval_ondevice.md         the on-device measurement Agent C runs and D scores
  data/manifest.csv        shot list, filled on site (one row per clip)
  data/splits/             heldout-<crossingId>.txt, committed
  eval/                    vehicle-events.csv, ped-signal-v1-device.csv, ped-signal-v1-report.md
  runs/<date>-<n>-<tag>/   weights + results.csv + confusion matrix + summary.json (weights not committed)
```

Raw video, frames, crops, labels and public sets live on the team drive (`data/.gitignore`).

## Class definitions (also in `label_schema.json` and the labelling prompt)

| Class | Label when | Box |
|---|---|---|
| `ped_walk` | The walking-figure lens is lit (steady) | The lit lens face only, not the housing |
| `ped_hand` | The hand lens is lit, steady or flashing, **without** visible digits | The lit lens face |
| `ped_countdown` | Digits are lit, with or without the hand | Digits and hand together as one lens face |
| (none) | No lens lit; lit vehicle signals; the head is out of frame; frame is an LED off-phase (skip) | — |

Every lit pedestrian lens in the crop is labelled with its true class, **including the
perpendicular crosswalk's head**. The detector finds heads; rejecting the wrong one is the
module's geometric gate, measured end-to-end (§7), not trained away. Frame attributes
(`crossingId`, `side`, `timeOfDay`, `weather`, `distanceM`, `state`, `perpVisible`,
`targetVisible`) live in `data/manifest.csv`, never in the label file. Negatives are 15–25 %
of the set: unlit heads, vehicle lamps, glare, underexposure, perpendicular-only clips.

## Procedure, in order

### 0. Rules check and setup (phase 0, day 0)

- Confirm with the organisers that datasets, labels, accounts and a trained model file count
  as preparation (08 open question 1). If not, everything below is re-run inside the event.
- `pip install -r requirements.txt` (Colab: `!pip install -r requirements.txt`); `ffmpeg` on PATH.
- Ask Agent C for the ARKit capture format (1920×1080 or 1280×720 — 09 §2 logs it) and write
  it into the manifest's `captureFormat` column. Do not guess: 20 m at 1280×720 is the bin most
  likely to fail, and if it does the fix is a capture-format change for C, not a retrain.

### 1. Public dataset survey (two hours, decision recorded) — 10 §3.1

Search Roboflow Universe and Kaggle for US-convention pedestrian-signal sets (white walking
figure, orange hand, countdown). For each candidate, before downloading a single image:

1. Record project URL, licence string and date in `LICENSES.md`. CC BY / CC0 / MIT fine;
   CC BY-NC fine for this prototype but stated; "unknown" or all-rights-reserved → do not use.
2. Sanity-check 50 random images by eye: US heads, boxes on the lit lens (a set that boxes
   the pole is unusable without relabelling).
3. **Exclude** ImVisible / LYTNet (PTL) and anything derived from it (non-US red/green person
   signals teach the wrong colours). **Exclude** vehicle traffic-light sets (LISA, Bosch,
   BSTLD) as positives but keep a slice as negatives (`data/public/negatives/`).

Public data are the warm start; local frames decide the gate. If no acceptable set exists,
train on local frames alone and say so in the report. Put accepted sets in
`data/public/{images,labels}` in YOLO format with the class order from `label_schema.json`.

### 2. Local capture (the part that determines the gate) — 10 §3.2

At each of the 2–3 candidate demo crossings (fixed-time signals preferred), on the demo
iPhone, at Agent C's capture format, a named human holding the phone:

- 3–5 min of video per crossing per signal state (walk, hand, countdown); stay for the cycles.
- Two times of day per crossing (the demo hour + one other sun angle); note the weather.
- Phone at chest height, tilted up ~10°, the demo lanyard/chest mount, standing where a
  pedestrian waits.
- 10–20 m from the head: the near curb (the real case), then short clips from marked 10 / 15 /
  20 m so recall bins by distance.
- Both approach sides; one clip facing along the parallel street so the perpendicular head is
  the only head in frame (the confusion set, `targetVisible=false, perpVisible=true`).
- 60 s of "nothing to see": heads unlit or out of frame, vehicle signals prominent, storefront
  lights, low sun in the lens.
- File names `data/raw/<crossingId>/<YYYYMMDD-HHMM>-<side>-<state>.mp4`. Fill
  `data/manifest.csv` **on site** (columns: `clip,crossingId,side,timeOfDay,weather,distanceM,
  state,perpVisible,targetVisible,captureFormat,phone,notes`; add `pitchDeg` and
  `transitionsS` ("12.5;41.0") when known — `extract_frames.py` uses both).
- The same files go to the fixtures pipeline (`fixtures/video/`, `fixtures/labels/`) and the
  approaching-vehicle events get hand-labelled into `eval/vehicle-events.csv`
  (`clip,startS,endS,direction,notes`) for the looming false-alarm budget.

Public sidewalks in Pittsburgh need no permission; ask on private property. Blur nothing at
capture time.

### 3. Frames and labels — 10 §3.3

```
python3 extract_frames.py --manifest data/manifest.csv --raw data/raw --out data --fps 2 --keep 45
ANTHROPIC_API_KEY=... python3 vlm_label.py --crops data/crops --out data/labels_vlm
```

- Extraction is at 2 fps, 30–60 frames per clip, biased to the seconds around hand→walk and
  walk→countdown; target 100–300 labelled local frames per crossing plus negatives.
- The crop is the module's geometry: 640×640 on the centre column and the horizon row, no
  downscale (10 §2). The full frame is kept beside it for the on-device replay.
- Drop frames with a legible bystander face in the crop.
- The VLM pass is labelling, not runtime (cents on Haiku). It is right about class and wrong
  about box tightness. `offPhaseSuspected` frames get a `.skip` marker — review them against
  their neighbours; do not label an LED off-phase frame as an unlit negative.
- **Hand-correct every frame** in Roboflow Annotate / Label Studio / CVAT (whichever the
  labeller already knows), export YOLO txt to `data/labels/<crossingId>/<clip>/`. Two people
  label the first 50 frames independently and compare; disagreements fix the definitions
  above, then one person continues. Nobody trains on an uncorrected VLM label.

### 4. Split and train — 10 §3.4, §4

Split by crossing, never by frame. Consecutive frames are near-duplicates; a random split
reports a fantasy.

```
# v0: public only — does the pipeline produce a model that finds any US head?
python3 train_yolo.py --run v0 --public data/public --no-local

# v1: public + local, one entire demo crossing held out (both times of day, all states, all distances)
python3 train_yolo.py --run v1 --public data/public --local data/crops --labels data/labels \
    --manifest data/manifest.csv --heldout crossing-forbes-01
```

`train_yolo.py` writes `data/splits/heldout-<crossingId>.txt` (commit it), counts instances
per class and caps the majority at ~3× the minority by dropping near-duplicate frames (never
synthesizes signal images), and trains YOLO11n from COCO weights with: `imgsz=640`,
`epochs=50`, `patience=15`, `batch=32` (16 on OOM), `close_mosaic=10`, `scale=0.5`,
`translate=0.1`, `degrees=5`, `hsv_v=0.6`, `hsv_s=0.7`, `hsv_h=0.015`, `fliplr=0.5`. If
Albumentations is installed, ultralytics wires RandomRain / RandomSunFlare in automatically
**[verify on the installed version]**; none of it replaces real dusk footage. A nano model on
one to three thousand images finishes well inside an hour on a T4 [verify on the first run;
record the time]. With three crossings, rotate the held-out once and report both folds.

Every run leaves `runs/<date>-<n>-<tag>/` with `summary.json`, `train/results.csv`,
`train/confusion_matrix.png` and per-class P/R. Anything not logged did not happen. v2 only if
§7 shows a fixable distance bin and new demo-phone frames exist. After v1's held-out number is
recorded, `--run ship` may retrain on all local crossings with the identical recipe; the report
states which model was measured and which shipped.

### 5. Export and the export check — 10 §5

```
python3 export_coreml.py --weights runs/<run>/train/weights/best.pt --run <run> \
    --name ped-signal-v1 --heldout-crops data/splits/heldout-crossing-forbes-01.txt \
    --heldout-crossing crossing-forbes-01
# COCO vehicle detector, same loading path (before the +6 h gate)
python3 export_coreml.py --weights yolo11n.pt --name coco-yolo-nano --coco
python3 export_coreml.py --weights yolo11n.pt --name coco-yolo-nano-416 --coco --imgsz 416
```

CoreML primary: `format=coreml, imgsz=640, half=True, nms=True` → a Vision-ready pipeline
(`VNCoreMLRequest` → `VNRecognizedObjectObservation`, no Swift decoding) **[verify the flag set
against the installed Ultralytics]**. If the NMS pipeline fails on the deployment target the
script ships `ped-signal-v1-raw.mlpackage` (`[1, 7, 8400]`) and Agent C runs NMS in Swift.
Input contract: RGB 640×640 letterboxed, 0–1 scaling inside the model (do not pre-normalize in
Swift). TFLite int8 (`--tflite`) is a backup for an Android build that may never exist.

Export check: ten held-out crops through the PyTorch model and the export, class indices must
agree — a swapped index is the silent failure that turns HAND into WALK. coremltools cannot
run a CoreML prediction on Linux, so on Colab the torch side is recorded and Agent C's first
load on the Mac completes the check before anything runs on the phone.

### 6. Handoff to Agent C — 10 §6

One PR against `models/` per artifact: the `.mlpackage`, its `.json` manifest (written by
`export_coreml.py`, label order `ped_walk, ped_hand, ped_countdown`, per-class thresholds,
held-out metrics, `measuredOn: python`), the `models/LICENSES.md` entry and a one-line
changelog. Agent C reviews and merges; D never commits into `models/`. Thresholds come from the
held-out PR curves: `ped_walk` at the lowest value keeping per-frame walk precision ≥ 0.95,
then read off recall; `ped_hand` / `ped_countdown` at the F1 knee. C may raise, never lower,
the walk threshold from device measurements. A new version is a new file name, never an
in-place edit.

### 7. On-device evaluation — `eval_ondevice.md`, 10 §7

Agent C replays the held-out crossing's **full frames** through the module's own crop, gate
and vote (the 09 §10 debug entry point) and exports `eval/emitted-<crossingId>.csv`; D scores:

```
python3 score_gate.py detector --pred runs/<run>/heldout_pred --labels data/labels --manifest data/manifest.csv --heldout crossing-forbes-01
python3 score_gate.py states --emitted eval/emitted-crossing-forbes-01.csv --truth eval/truth-crossing-forbes-01.csv --out eval/ped-signal-v1-gate.json
```

Numbers go to `eval/ped-signal-v1-device.csv` with phone model, iOS version, capture format,
thermal state and build id; the manifest flips to `measuredOn: device`. Repeat at integration
start with the final module build.

### 8. Report — 10 §10

`eval/ped-signal-v1-report.md`, one page, exactly the seven sections in the template, device
numbers, at least one concrete failure with a frame, the rung actually shown in the demo.
Linked from the app README and handed to the pitch owner. The Nemotron eval is Agent B's
separate page.

## The other models in this track (no training) — 10 §8

- **COCO vehicle detector:** pretrained YOLO11n, exported as above (640 and 416). Its metric
  is not mAP but the looming filter's false-alarm rate on the curb footage against
  `eval/vehicle-events.csv`: < 1 false STOP per 5 min and STOP within 1 s of a labelled
  approach on the majority of events. C tunes 09 §5.2; D labels and scores.
- **Depth Anything V2 small (CoreML) [verify]:** locate an existing CoreML build (Apple has
  published Core ML conversions), confirm input size (518 class) and licence (small expected
  permissive; larger variants non-commercial), send as a §6 PR in phase 0. No build → two hours
  for a coremltools conversion → else C falls back to heading + dead reckoning (08 R27).
- **Walkable-surface segmentation:** optional, phase 2, only after the signal model passes.

## Fallback ladder triggers — 10 §9

| Observation | Action |
|---|---|
| No v1 on the phone by integration start | Rung 2 (Sonnet 5 curb crop, "Signal read is delayed") is the plan of record; training continues in phase-1 hours 1–6 |
| False-WALK precision ≤ 95 % (device) | Rung 2 immediately; one attempt at raising `ped_walk`, no more |
| Precision > 95 % but recall ≤ 80 % at 10–20 m | Stay on rung 1; "Can't see the signal" is more frequent; state it; one capture-format fix for 20 m |
| Parallel confusion ≥ 2 % after the gate | Tighten the gate once (±15°, narrower strip), re-measure in an hour; still ≥ 2 % → rung 3 |
| Signal fps < 15 in APPROACH | COCO to 10 fps, then input 416; still < 10 fps → rung 2 |
| Looming > 1 false STOP / 5 min after one threshold pass | Cut vehicle warnings; STOP stays for hard obstacles |
| Any rung | Rung 4 — manual signal state in DebugPanel — is wired from day 0 and never removed |

## Definition of done (10)

- [ ] `LICENSES.md` lists every dataset and framework licence with dates; nothing "unknown"
- [ ] ImVisible / LYTNet and vehicle-light positives excluded; vehicle lamps present as negatives
- [ ] Local capture complete: 2–3 crossings × 3 states × 2 times of day, 10/15/20 m, both sides, perpendicular-only clips, `manifest.csv` filled on site
- [ ] Every training frame hand-corrected after the VLM pass; first 50 double-labelled
- [ ] Split is leave-one-crossing-out; `data/splits/heldout-<crossingId>.txt` committed
- [ ] v0 and v1 logged under `runs/`
- [ ] `ped-signal-v1.mlpackage` + manifest delivered as a PR Agent C merged
- [ ] `coco-yolo-nano.mlpackage` (+ 416) delivered the same way before the +6 h gate
- [ ] Python export check: class indices match on ten held-out crops
- [ ] Device measurement in `eval/ped-signal-v1-device.csv`; manifest `measuredOn: device`
- [ ] +14 h gate decided against §1; rung recorded; model frozen afterwards
- [ ] `eval/vehicle-events.csv` labelled; looming false-alarm rate scored
- [ ] Depth Anything V2 small located with licence, or the conversion attempt recorded
- [ ] `eval/ped-signal-v1-report.md` complete with a real failure case and device numbers
- [ ] Nothing committed outside `training/` by this track
