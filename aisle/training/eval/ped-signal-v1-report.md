# Pedestrian-signal detector v1 — evaluation (one page, for judges)

> Template per `10-CV-TRAINING-TRACK.md` §10: exactly these seven sections, in this order,
> device numbers, one page when rendered. Replace every `TBD` in phase 3 after the live venue
> runs; do not publish with a `TBD` left in §4 or §5. The Nemotron evaluation is Agent B's
> separate page.

## 1. What it is

A three-class on-device detector (`ped_walk`, `ped_hand`, `ped_countdown`), YOLO11n at
640×640 on a native-resolution centre-band crop, running inside the phone's perception module
at **TBD fps** on a **TBD (non-Pro iPhone, iOS TBD)** alongside the COCO vehicle detector and
the depth model. Its output passes a geometric gate (body heading within ±20° of the crossing
bearing, horizon strip, nearest-centre) and a 5-of-8 vote before the app says anything. It
reports signal state; it never decides when to cross.

## 2. Data

- Public sets: **TBD** (name, licence, images) — see `training/LICENSES.md`. ImVisible /
  LYTNet excluded (non-US signals); vehicle-light sets used only as negatives.
- Local frames: **TBD** frames from **TBD** crossings × 3 states × 2 times of day, 10 / 15 /
  20 m and curb bins, both approach sides, perpendicular-only clips. Negatives **TBD %**.
- Labelling: Claude Haiku 4.5 first pass with a strict schema, every frame hand-corrected;
  first 50 frames double-labelled, agreement **TBD**.
- Honesty: OKO's model trained on > 150 000 images; this one on **TBD**. That gap is why the
  gate, the vote, the onset rule and the fallback ladder exist.

## 3. Split

Leave-one-crossing-out: **TBD crossingId** held out entirely (both times of day, all states,
all distances; `training/data/splits/heldout-<crossingId>.txt`). No held-out frame was seen in
training; public data never appear in the held-out numbers. Model measured: run
`training/runs/TBD`. Model shipped: **TBD** (same run, or the all-crossings retrain with the
identical recipe — state which).

## 4. Results (device numbers, held-out crossing)

| Class | 10 m P / R | 15 m P / R | 20 m P / R | curb P / R |
|---|---|---|---|---|
| ped_walk | TBD | TBD | TBD | TBD |
| ped_hand | TBD | TBD | TBD | TBD |
| ped_countdown | TBD | TBD | TBD | TBD |

| End-to-end (after gate + vote) | Value | Gate | Result |
|---|---|---|---|
| False-WALK precision | TBD | > 95 % | TBD |
| WALK recall, 10–20 m | TBD | > 80 % | TBD |
| HAND recall, 10–20 m | TBD | > 80 % | TBD |
| Parallel-signal confusion | TBD | < 2 % | TBD |
| Signal-model fps (APPROACH profile, COCO + depth running) | TBD | ≥ 15 | TBD |
| Frame → `onSignalState` change | TBD ms | < 100 ms | TBD |

COCO looming filter on curb footage (`training/eval/vehicle-events.csv`): **TBD** false STOPs
per 5 min (budget < 1); STOP within 1 s of a labelled approach on **TBD / TBD** events.

## 5. A failure we found

**TBD** — one concrete case with the frame: the distance bin that failed, the LED off-phase
flicker frame, the glare case, or the perpendicular head the raw detector loved and the gate
had to kill. What it looked like, what the app did, what changed because of it.

## 6. Limits

Night and rain (no training data; the app says so out loud); upside-down or unusual heads;
beyond 20 m; the ~70° forward field of view (cross traffic at the curb is unseen until the
user turns — hearing stays the primary vehicle sensor); training-set size versus OKO's; the
fallback-ladder rung actually shown in the demo: **TBD (1 on-device / 2 Sonnet curb crop /
3 alignment + map awareness / 4 manual)**.

## 7. Reproduce

Run id `training/runs/TBD`; recipe in `training/train_yolo.py`; manifest
`models/ped-signal-v1.json`; one command:

```
python3 training/train_yolo.py --run v1 --public data/public --local data/crops --labels data/labels \
    --manifest data/manifest.csv --heldout TBD
```
