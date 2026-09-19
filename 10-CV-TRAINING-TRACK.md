# 10 — CV Training Track (Agent D runs it, Agent C integrates)

**You own the only model in Aisle that is trained rather than downloaded, and it is the
one whose mistake hurts most.** The pedestrian-signal detector decides whether the app says
"Walk signal on". Everything else in this track (the COCO vehicle detector, the depth model,
the optional segmentation model) is acquisition, export and measurement, not training.

**Owns:** `training/` (data, notebooks, export scripts, evaluation report)
**Never touches:** `models/` — Agent C owns that directory (`09-PERCEPTION-MODULE.md` §1);
every artifact in §6 crosses as a PR that Agent C merges, per
`06-INTEGRATION-AND-DEMO.md`. Also never: `modules/perception/`, `src/perception/`,
`src/indoor/`, `src/core/`, `src/outdoor/`, `src/crossing/`
**Contracts:** class names are `Detection.cls` in `01-SHARED-CONTRACTS.md` §7; the module
that consumes the model is `09-PERCEPTION-MODULE.md` §3 and §5.1. Neither changes for this
track's convenience.

Agent D runs this on the Windows machine plus Colab; the on-device half of every step is
Agent C's on Mac 1 with the demo iPhone. A named human holds the phone at every capture
session. Check the hackathon rules on pre-event work first: datasets, labels, accounts and
environment are normally allowed; treat the trained model as "data prepared" unless the
rules say otherwise, and be ready to retrain from scratch inside the event if they do.

---

## 1. Goal and gates

Deliver `models/ped-signal-v1.mlpackage`: a YOLO-nano detector with three classes,
`ped_walk`, `ped_hand`, `ped_countdown`, that runs at ≥ 15 fps inside the APPROACH_CROSSING
profile on the demo phone and, after the module's geometric gate and 5-of-8 vote, satisfies
on **held-out local frames**:

| Metric | Gate | Why this number |
|---|---|---|
| False-WALK precision (emitted WALK states that are truly WALK) | > 95 % | A false WALK is the harm model's worst case |
| WALK and HAND recall at 10–20 m | > 80 % | Below this the user hears "Can't see the signal" too often to trust it |
| Parallel-signal confusion after the gate | < 2 % | The other crosswalk's head is often larger in frame; the gate must kill it |
| On-device throughput, signal + COCO + depth running | ≥ 15 fps | Anything slower misses WALK intervals as short as 4–7 s |

The gate is judged at **+14 h from integration start**; the +6 h gate (Tier 0 loop live with
STOP on recorded footage) depends only on this track's COCO export. Miss the +14 h gate and
the crossing beat moves down the ladder in §9. Nothing about the fallback is shameful; the
demo works at every rung. What is not acceptable is shipping a model whose WALK precision
was never measured.

Honesty budget: OKO's model was trained on more than 150,000 images. Ours will be trained on
hundreds to low thousands, from two or three crossings. Say that in the report and in the
pitch; it is why the gate, the vote, the onset rule and the fallback ladder exist.

---

## 2. What the model has to see

- MUTCD symbols are at least 6 in high, 9 in where the pedestrian is more than 100 ft from
  the head. Derived pixel budget on a ~69° phone camera: a 9-inch symbol is ~13 px at 20 m and
  ~26 px at 10 m once a frame is downscaled to ~1568 px long edge; a 6-inch symbol is
  two-thirds of that. This is why 09 §3 feeds the model a **640×640 crop of the native
  centre band** with no downscale, and why this track must train on the same geometry.
- LED heads are PWM-driven; a rolling-shutter frame can catch a lit lens dark or banded. A
  single dark frame means nothing; the module's 5-of-8 vote absorbs it, and the labeller must
  not label an "off-phase" frame as unlit-negative when neighbouring frames show it lit
  (skip such frames instead).
- Crosswatch (2010) found the Walk icon "small and blurry" across the street, restricted the
  search to an accelerometer-derived horizon strip, and named false positives its top
  remaining problem. Expect the same; the gate is the module's, the data are yours.
- No cloud VLM decides state: the one peer-reviewed evaluation of a general VLM on
  crossing images scored 25 %. The VLM's job in this track is first-pass labelling only.

---

## 3. Data plan

### 3.1 Public datasets — evaluate, do not assume

Search Roboflow Universe and Kaggle for US-convention pedestrian-signal projects: classes
along the lines of walk / hand / countdown, white walking figure and orange hand on US-style
heads. Specific candidates are **[verify]**; the two dossiers that would have named them
did not complete. Rules:

- **Exclude ImVisible / LYTNet (PTL)** and anything derived from it: red/green person
  signals in a non-US style. Training on them teaches the wrong colours and shapes.
- Exclude vehicle traffic-light sets (LISA, Bosch, BSTLD-class) as positives; **keep a
  slice of them as negatives** because vehicle green and red lamps are the most likely
  false positive for a walk/hand detector [verify availability and licence].
- Licence check per dataset, recorded in `training/LICENSES.md` before a single image is
  downloaded: CC BY / CC0 / MIT are fine; CC BY-NC is fine for a non-commercial hackathon
  prototype but must be stated; "unknown" or "all rights reserved" means do not use.
  Roboflow Universe projects declare a licence per project; record the project URL, the
  licence string and the download date.
- Sanity-check each candidate by eye: 50 random images, confirm US heads, confirm boxes
  are on the lit lens rather than the whole pole. A set that boxes the pole is unusable
  without relabelling.
- Public data are the warm start; local frames decide the gate. If no acceptable public
  set exists, the model trains on local frames alone and the report says so.

### 3.2 Local capture protocol (the part that determines the gate)

At each of the 2–3 candidate demo crossings (fixed-time signals preferred, per
`03-AGENT-B-outdoor-crossing.md`), on the demo iPhone, at the capture resolution Agent C
has chosen for the ARKit session (1920×1080 if available, else 1280×720 — ask, do not
guess; 09 §2 logs the format):

- **3–5 minutes of video per crossing per signal state** (walk, hand, countdown), so that
  each state is observed across several cycles. At a 4–7 s WALK the walk footage takes the
  longest to accumulate; stay for the cycles.
- **Two times of day** at each crossing: the rehearsal/demo hour and one other with
  different sun angle (morning vs late afternoon). Note the weather.
- **Phone at chest height, tilted up ~10°**, the same lanyard or chest mount the demo will
  use, held by a person standing where a pedestrian waits.
- **10–20 m from the head**: record from the near curb (the real case), then repeat short
  clips from marked 10 m, 15 m and 20 m positions so recall can be binned by distance.
- **Both approach sides** of each crossing, and one clip facing along the parallel street
  so the perpendicular head is the only head in frame (the confusion set).
- Also record 60 s of "nothing to see": the intersection with heads unlit or out of frame,
  vehicle signals prominent, storefront lights, low sun in the lens.
- Name files `training/data/raw/<crossingId>/<YYYYMMDD-HHMM>-<side>-<state>.mp4`; write
  the shot list into `training/data/manifest.csv` on site (see 3.4). Raw video is not
  committed to git; share it through the team drive and hand the same files to the
  fixtures pipeline (`05-AGENT-D-harness-transition-demo.md`).

Ask permission if the crossing is on private property; public sidewalks in Pittsburgh
need none. Blur nothing at capture time; faces are handled at frame selection (§3.3).

### 3.3 Frame extraction and labelling

1. Extract at 2 fps with ffmpeg; from each clip keep 30–60 frames, biased toward state
   transitions (the seconds around hand→walk and walk→countdown) and evenly across the rest.
   Target **100–300 labelled local frames per crossing** plus the negatives.
2. Crop each frame to the module's geometry: a 640×640 window centred on the frame's
   centre column and on the horizon row (estimate the horizon row per clip from the phone
   pitch, or take the vertical centre if pitch was not logged). Train on these crops. Keep
   the full frame beside the crop; the evaluation replay uses the full frame.
3. Drop frames with a legible bystander face in the crop; there are enough frames.
4. **VLM first pass:** send each crop to Claude Haiku 4.5 through the proxy with a strict
   schema `{boxes: [{cls, x, y, w, h}], unlit: boolean, perpendicularHeadVisible: boolean}`
   and the class definitions below verbatim in the prompt. This is labelling, not runtime;
   it costs cents. Expect it to be right about class and wrong about box tightness.
5. **Hand correction of every frame** in a box-labelling tool that exports YOLO txt
   (Roboflow Annotate, Label Studio or CVAT [verify which the labeller already knows]).
   Nobody trains on an uncorrected VLM label. Two people label the first 50 frames
   independently and compare; disagreements fix the definitions, then one person continues.

Class definitions (put these in `training/README.md` and in the labelling prompt):

| Class | Label when | Box |
|---|---|---|
| `ped_walk` | The walking-figure lens is lit (steady) | The lit lens face only, not the housing |
| `ped_hand` | The hand lens is lit, steady or flashing, **without** visible digits | The lit lens face |
| `ped_countdown` | Digits are lit, with or without the hand | Digits and hand together as one lens face |
| (none) | No lens lit; lit vehicle signals; the head is out of frame; frame is an LED off-phase (skip) | — |

- Every lit pedestrian lens in the crop is labelled with its true class, **including the
  perpendicular crosswalk's head**. The detector must find heads; rejecting the wrong one is
  the geometric gate's job, and it is measured end-to-end (§7), not trained away.
- Frame-level attributes live in `manifest.csv`, not in the label file: `crossingId`,
  `side`, `timeOfDay`, `weather`, `distanceM` (10 / 15 / 20 / curb), `state` (ground-truth
  state of the **target** head), `perpVisible`, `targetVisible`.
- Negatives are 15–25 % of the set: unlit heads, vehicle lamps, glare, night-like
  underexposure, and the perpendicular-only clips (labelled truthfully, tagged
  `targetVisible=false`).

### 3.4 Split — by crossing, never by frame

Consecutive frames from one video are near-duplicates; a random split would report a
fantasy. Rules:

- **Leave-one-crossing-out:** the held-out set is one entire demo crossing, both times of
  day, all states, all distances. Report the gate metrics on it. If there are three
  crossings, rotate once and report both folds.
- Public data are training-only; they never appear in the held-out numbers.
- The model that ships may be retrained on all local crossings with the identical recipe
  after the held-out number is recorded, and the report states which model was measured
  and which shipped. Do not report the retrained model's number on its own training data.
- Keep `training/data/splits/heldout-<crossingId>.txt` so the evaluation is reproducible.

---

## 4. Training recipe

Ultralytics YOLO11n (or YOLOv8n if the toolchain fights you) from COCO-pretrained weights;
licence AGPL-3.0 for the framework and weights **[verify current terms]**, recorded in
`training/LICENSES.md` and carried into `models/LICENSES.md` by the handoff PR (§6). Colab
free T4 is enough: a nano model at 640 px on one to three thousand images for ~50 epochs
finishes well inside an hour [verify on the first run; record the time].

- `imgsz=640`, `epochs=50`, `patience=15`, `batch=32` (drop to 16 on memory error),
  default optimizer. `close_mosaic=10` so the last epochs see un-tiled crops.
- Small-object bias: `scale=0.5` so the symbol spans the 8–40 px range seen at 10–20 m;
  `translate=0.1`; `degrees=5` (heads are rarely tilted; OKO users report an upside-down
  mount as a failure, do not chase it).
- Glare / night / rain: `hsv_v=0.6`, `hsv_s=0.7`, `hsv_h=0.015`; add brightness and
  contrast jitter, gaussian blur and mild gaussian noise; if Albumentations is present,
  RandomRain and RandomSunFlare at low probability [verify the installed version wires them
  in automatically]. None of this replaces real dusk footage; it only softens the cliff.
- `fliplr=0.5` is fine: walking figures face either way in the wild and no class depends
  on digit legibility.
- **Class balance:** count instances per class before training. Countdown and walk are the
  rarer states in raw footage (short intervals). Cap the majority class at ~3× the
  minority by dropping near-duplicate frames from the majority, or use per-image sampling
  weights; do not synthesize signal images.
- Log per-class precision/recall and the confusion matrix from the validation split each
  run; keep `training/runs/<date>-<n>/` (weights + `results.csv`) and note the run id in the
  manifest (§6). Anything not logged did not happen.

Two required runs: **v0** on public data only (sanity: does the pipeline produce a model
that finds any US head?), **v1** on public + local with one crossing held out. v2 is a
phase-1 retrain only if v1 misses a distance bin and new frames from the demo phone can
close it.

---

## 5. Export

Export in Colab; coremltools converts on Linux but cannot run a CoreML prediction there,
so the first real check of any `.mlpackage` is Agent C's on the Mac and the phone.

- **CoreML (primary):** `format=coreml`, `imgsz=640`, `half=True`, `nms=True` so the
  package is a Vision-ready pipeline that returns per-box class confidences and normalized
  coordinates and Agent C can use `VNCoreMLRequest` → `VNRecognizedObjectObservation` with
  no Swift decoding [verify the flag set against the installed Ultralytics version; if the
  NMS pipeline export fails on the deployment target, ship the raw-head export
  `models/ped-signal-v1-raw.mlpackage` (output `[1, 7, 8400]` = 4 box + 3 class scores)
  and Agent C runs NMS in Swift]. Set the package's class labels to the exact order in §6.
- **TFLite int8 (backup only, for an Android build if one is ever made):** `format=tflite`,
  `int8=True`, `imgsz=640`, calibration data = the training set yaml. Output is the raw
  head without NMS. Not a gate item; do it once after v1 passes, or never.
- Input contract for both: RGB, 640×640, letterboxed, pixel values scaled 0–1 by the
  model (do not pre-normalize in Swift). Say this in the manifest.
- Verify the export on ten held-out crops in Python (`.predict` on the exported file) and
  confirm class indices match the PyTorch model before handing over. A swapped label
  index here is the silent failure that turns HAND into WALK.

The COCO vehicle detector is exported the same way (§8) so Agent C has one loading path.

---

## 6. Handoff contract to Agent C

`models/` is Agent C's directory; you never commit into it. Each artifact below is delivered
as a **PR against `models/` that Agent C reviews and merges** — the model file, its manifest
and its `models/LICENSES.md` entry in one PR, with a one-line changelog. The paths below are
where each file lands after that merge:

```
models/ped-signal-v1.mlpackage           the model (Vision pipeline with NMS)
models/ped-signal-v1.json                manifest (below)
models/ped-signal-v1.tflite              backup, optional
models/coco-yolo-nano.mlpackage          pretrained COCO, §8
models/coco-yolo-nano.json               manifest, same shape
models/LICENSES.md                       per-model and per-dataset licences
```

```json
{
  "name": "ped-signal-v1",
  "arch": "yolo11n",
  "runId": "training/runs/2026-09-18-03",
  "input": { "width": 640, "height": 640, "letterbox": true, "colour": "RGB", "scale": "0-1" },
  "labels": ["ped_walk", "ped_hand", "ped_countdown"],
  "nms": { "embedded": true, "iouThreshold": 0.5 },
  "confThreshold": { "ped_walk": 0.40, "ped_hand": 0.35, "ped_countdown": 0.35 },
  "heldOutCrossing": "crossing-forbes-01",
  "metrics": { "falseWalkPrecision": 0.97, "recallWalk10to20m": 0.84, "recallHand10to20m": 0.88,
               "perpConfusionAfterGate": 0.01, "measuredOn": "device|python" },
  "trainedOn": { "publicImages": 0, "localFrames": 0, "negatives": 0 },
  "licences": ["training/LICENSES.md"]
}
```

- **Label order is fixed** to the manifest array and to the `Detection.cls` union in
  01 §7. Index 0 = `ped_walk`. Agent C reads labels from the manifest, never hard-codes.
- **Thresholds** are per class and come from the held-out precision–recall curves: choose
  the `ped_walk` threshold first, at the lowest value that keeps per-frame walk precision
  ≥ 0.95 on the held-out crossing, then read off recall; `ped_hand` and `ped_countdown`
  at the F1 knee. Agent C applies these before the 5-of-8 vote and may raise, never lower,
  the walk threshold from device measurements.
- `measuredOn` starts as `python` (D's export check) and becomes `device` once Agent C
  has run §7: D scores the run and sends the updated manifest, Agent C commits it under
  `models/`.
- The COCO manifest carries the 80-class COCO label order and the six classes the module
  keeps (`car`, `bus`, `truck`, `motorcycle`, `bicycle`, `person`); filtering is Agent C's.
- A new model version is a new file name (`ped-signal-v2.*`) in a new PR; 09's schedule and
  filter code stay put and only the file reference moves. No silent overwrite of v1, and no
  in-place edit of a merged artifact.

---

## 7. On-device evaluation (Agent C runs, Agent D scores)

Two levels, both on the held-out crossing's **full frames** replayed through the module's
own crop and gate (a debug entry point that feeds stills or a recorded video into the same
pipeline as live frames; 09 §10 asks for it):

1. **Per-frame detector:** precision and recall per class, binned by `distanceM`
   (10 / 15 / 20 / curb) and by `timeOfDay`. This tells you whether the model or the
   geometry is the problem when a bin fails (20 m at 1280×720 is the bin most likely to
   fail; if it does and 1920×1080 is available, that is a capture-format change for Agent C
   to make, not a retrain).
2. **Emitted states** after the geometric gate (body heading within ±20° of the crossing
   bearing, horizon strip, nearest-centre) and the 5-of-8 vote — what the user hears:
   - **False-WALK precision** = emitted WALK states whose target-head truth is WALK, over all
     emitted WALK states. Truth of hand, countdown, unlit or "target not visible" all count
     as false. Gate: > 95 %.
   - **Recall** = fraction of ground-truth WALK (and HAND) spans of ≥ 2 s during which the
     matching state was emitted at least once within 1 s of onset. Gate: > 80 % at 10–20 m.
   - **Parallel-signal confusion** = emitted non-UNKNOWN states on the perpendicular-only
     clips (`targetVisible=false`, `perpVisible=true`) with the crossing bearing set to the
     target crossing, over all frames in those clips. Gate: < 2 %. If the raw detector
     finds the perpendicular head (it should) but the gate passes it, the fix is in 09 §5.1,
     not in training.
   - **Onset correctness:** every DONT_WALK→WALK transition in the held-out footage yields
     one `fresh: true`; a clip started mid-WALK yields `fresh: false`.
3. **Throughput and latency** in the APPROACH_CROSSING profile with COCO at 15 fps and
   depth at 10 fps running concurrently: signal-model fps ≥ 15 and frame → `onSignalState`
   change < 100 ms, measured from `getStats()` and DebugPanel, phone warm (10 minutes of
   running), not fresh from a pocket.
4. Record every number in `training/eval/ped-signal-v1-device.csv` with phone model, iOS
   version, capture format, thermal state and build id.

Repeat the measurement at integration start with the final module build; models do not
change, but capture formats, thermal state and module code do.

---

## 8. The other models in this track (no training)

**Vehicle detector.** Pretrained COCO YOLO11n (or YOLOv8n), no fine-tune. Export as in
§5 (`nms=True`, `imgsz=640`; also produce a 416 export as `coco-yolo-nano-416.mlpackage`
in case the fps gate is missed). Classes are filtered downstream. Its evaluation is not
mAP: it is the looming filter's false-alarm rate on the curb footage from §3.2, with the
approaching-vehicle events hand-labelled by D as time spans (`training/eval/vehicle-events.csv`:
clip, start, end, direction). Gate: < 1 false STOP per 5 minutes of curb footage and
STOP within 1 s of a labelled approach on the majority of events. Agent C tunes the growth
and track-age thresholds in 09 §5.2; D supplies the labels and scores the runs. Cart is not
a COCO class; a cart fine-tune is not in this track unless the signal model is done and
there is a day to spare.

**Depth Anything V2 small (CoreML) [verify].** Locate an existing CoreML build (Apple has
published Core ML conversions of Depth Anything V2; confirm the exact repository, the
input size — 518 px class — and the licence, which for the small variant is expected to be
permissive while larger variants are non-commercial [verify all three]). If a build exists,
download, record the licence, and send it as a §6 PR that lands at
`models/depth-anything-v2-small.mlpackage` in phase 0; Agent C measures ms per frame and
calibrates NEAR/MID/FAR by walking at a wall (09 §5.3). If no build exists, budget two
hours for a coremltools conversion from the PyTorch checkpoint; if that fails, tell Agent C
to fall back to heading + dead reckoning for obstacles (R27 in
`08-ROADMAP-AND-CONCERNS.md`).

**Walkable-surface segmentation (optional, later) [verify].** A Cityscapes-class model
(road / sidewalk / wall / building) exported to CoreML at ~512×256, ≥ 5 fps on the demo
phone, would give the curb-line offset in 09 §5.6. Do not start it before the signal model
passes its gate and the report exists; if it happens, it is a phase-2 item with its own
manifest (`models/walkable-seg.json`) and no gate depends on it.

---

## 9. Fallback ladder — trigger criteria

The ladder is in `08-ROADMAP-AND-CONCERNS.md` and the controller behaviour in
`03-AGENT-B-outdoor-crossing.md`; this section says **when** to move:

| Observation | Action |
|---|---|
| No v1 export on the phone by integration start | Plan of record is rung 2 (Sonnet 5 curb crop, thinking off, "Signal read is delayed"); training continues in phase-1 hours 1–6 with whatever local frames exist |
| False-WALK precision ≤ 95 % on held out (device numbers) | Rung 2 immediately. Do not ship a model that lies about WALK; no threshold fiddling past one attempt of raising `ped_walk` and re-measuring |
| Precision > 95 % but recall ≤ 80 % at 10–20 m | Stay on rung 1; "Can't see the signal" will be more frequent; state it in the report and the pitch; try a 20 m-only fix (capture format) once |
| Parallel confusion ≥ 2 % after the gate | Tighten the gate once (±15°, narrower strip) and re-measure within one hour; still ≥ 2 % → rung 3 (alignment + map awareness, no state claim) |
| Signal fps < 15 in the APPROACH profile | Drop COCO to 10 fps in that profile, then input 416; still < 10 fps → rung 2 |
| Rung 2 itself scores < 95 % WALK precision on the same 20 held-out signal-head crops | Rung 3 |
| Vehicle looming > 1 false STOP per 5 min after one threshold pass | Cut vehicle warnings (third item in the cut order); STOP stays for hard obstacles |
| Any rung | Rung 4 — manual signal state on DebugPanel — is wired from day 0 and is never removed |

Every move down the ladder changes the demo script's wording and the report's headline;
tell the pitch owner within the hour, not at rehearsal.

---

## 10. Evaluation report for judges (one page)

`training/eval/ped-signal-v1-report.md`, finished in phase 3, linked from the README and
handed to whoever writes the pitch (`06-INTEGRATION-AND-DEMO.md`). Exactly these sections,
in this order, one page when rendered:

1. **What it is.** Three-class on-device pedestrian-signal detector; where it runs (phone,
   fps); what it never does (decide when to cross).
2. **Data.** Public sets used with licences; local frames per crossing / state / time of
   day / distance; negatives; who labelled and how (VLM first pass, hand-corrected).
3. **Split.** Which crossing was held out; that no held-out frame was seen in training.
4. **Results table.** Per-class precision and recall at 10 / 15 / 20 m; false-WALK
   precision; parallel confusion after the gate; fps and frame→event ms on the demo phone;
   the vehicle looming false-alarm rate on curb footage. Device numbers, not Python numbers.
5. **A failure we found.** At least one concrete case with a frame: the bin that failed,
   the flicker frame, the glare case, the perpendicular head that the raw detector loved.
   Judges trust a team that found its own failure.
6. **Limits.** Night, rain, upside-down or unusual heads, distance beyond 20 m, FOV;
   training-set size versus OKO's; the ladder rung actually shown in the demo.
7. **Reproduce.** Run id, notebook path, manifest, one command.

A second, shorter table for the COCO looming filter lives in the same file. The Nemotron
evaluation artifact is Agent B's and is a separate page; do not merge them.

---

## 11. Timeline within phase 0 and phase 1

Phase 0 (before integration; take the time it needs, capture spans at least one full day
because of the two-times-of-day rule):

1. Rules check on pre-event work; open `training/` with README, LICENSES.md, empty manifest.
2. Public dataset survey and licence check, two hours, decision recorded (§3.1).
3. Capture session 1 at all candidate crossings (needs the chosen crossings from the venue
   walk in `11-PHASE-0-CHECKLIST.md` and the demo phone's capture format from Agent C).
4. Frame extraction, VLM first pass, hand correction of session-1 frames; v0 run on public
   data in parallel.
5. Capture session 2 (other time of day); label; v1 run with one crossing held out;
   export; Python export check; manifest with `measuredOn: python`.
6. Handoff: open the §6 PR; Agent C merges it, loads `ped-signal-v1.mlpackage` and
   `coco-yolo-nano.mlpackage` into the module, runs §7 and commits the device numbers. Depth
   Anything located and sent the same way.
7. Vehicle event labels (`vehicle-events.csv`) delivered with the curb footage to the
   fixtures pipeline.

Phase 1 (relative to integration start):

- 0–6 h: nothing new from this track; the +6 h gate uses the COCO export. If v1 did not
  exist at integration start, this window is the v1 training window and rung 2 is armed.
- 6–12 h: v2 only if §7 shows a fixable bin and new demo-phone frames exist; otherwise
  threshold confirmation and the device CSV.
- **+14 h: gate.** Decide the rung. After this the model is frozen; only Agent C's
  thresholds may move, upward.
- 18 h+: report draft with device numbers; final in phase 3 after the live venue runs.

---

## Definition of done

- [ ] `training/LICENSES.md` lists every dataset and framework licence used, with dates; nothing "unknown"
- [ ] ImVisible / LYTNet and vehicle-light positives excluded; vehicle lamps present as negatives
- [ ] Local capture complete: 2–3 crossings × 3 states × 2 times of day, 10 / 15 / 20 m clips, both sides, perpendicular-only clips, `manifest.csv` filled on site
- [ ] Every training frame hand-corrected after the VLM pass; class definitions in `training/README.md`; first 50 frames double-labelled
- [ ] Split is leave-one-crossing-out; `training/data/splits/heldout-<crossingId>.txt` committed
- [ ] v0 (public-only) and v1 (public + local) runs logged under `training/runs/`
- [ ] `ped-signal-v1.mlpackage` + `.json` manifest with label order `ped_walk, ped_hand, ped_countdown`, per-class thresholds and held-out metrics, delivered as a PR Agent C merged into `models/`
- [ ] `coco-yolo-nano.mlpackage` (+ 416 variant) and manifest delivered the same way before the +6 h gate
- [ ] Python export check: class indices match on ten held-out crops
- [ ] Agent C's device measurement recorded in `training/eval/ped-signal-v1-device.csv`; manifest updated to `measuredOn: device`
- [ ] +14 h gate decided against §1 and the rung recorded; model frozen afterwards
- [ ] `vehicle-events.csv` labelled; looming false-alarm rate scored on curb footage
- [ ] Depth Anything V2 small CoreML located with licence, or the conversion attempt and its outcome recorded [verify]
- [ ] `training/eval/ped-signal-v1-report.md` complete with a real failure case and device numbers
- [ ] Nothing committed outside `training/` by this track; every `models/` artifact arrived as a PR Agent C merged
