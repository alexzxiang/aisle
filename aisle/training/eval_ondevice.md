# On-device evaluation (10 §7) — Agent C runs, Agent D scores

Two levels, both on the held-out crossing's **full frames** replayed through the module's own
crop + geometric gate + 5-of-8 vote (the debug entry point 09 §10 asks for: stills or a
recorded video fed into the same pipeline as live frames). Python numbers from
`export_coreml.py` are a smoke test; the gate is decided on the numbers below.

## What Agent C exports

1. **Per-frame detector output** on the held-out crops: YOLO txt with confidence
   (`cls x y w h conf`), one file per crop, mirrored under `runs/<run>/heldout_pred/` with the
   same `<crossingId>/<clip>/<frame>.txt` paths as `data/labels/`.
2. **Emitted states** after the gate and the vote, per replayed clip:
   `eval/emitted-<crossingId>.csv` with columns `clip,tS,state,fresh` — one row per
   `onSignalState` emission (change + 0.5 Hz heartbeat), `tS` seconds from clip start,
   `state` ∈ WALK | DONT_WALK | COUNTDOWN | UNKNOWN, `fresh` true/false. The crossing bearing
   is set to the **target** crossing for every clip, including the perpendicular-only ones.
3. **Throughput and latency** from `getStats()` and DebugPanel in the APPROACH_CROSSING
   profile with COCO at 15 fps and depth at 10 fps running concurrently, phone warm (10 min
   running, not fresh from a pocket): signal-model fps and frame → `onSignalState` change ms.

## What Agent D supplies

- `eval/truth-<crossingId>.csv` with columns `clip,tS,state,distanceM,targetVisible,perpVisible`,
  `state` = ground truth of the **target** head (WALK | DONT_WALK | COUNTDOWN | UNLIT | NONE),
  one row per second (or per labelled span edge), built from the hand-labelled signal-state
  spans in `fixtures/labels/crossing-<id>.json` and the manifest attributes.
- The scoring:

```
python3 score_gate.py detector --pred runs/<run>/heldout_pred --labels data/labels \
    --manifest data/manifest.csv --heldout <crossingId>
python3 score_gate.py states --emitted eval/emitted-<crossingId>.csv \
    --truth eval/truth-<crossingId>.csv --out eval/ped-signal-v1-gate.json
```

## Definitions (verbatim intent of 10 §7)

| Metric | Definition | Gate |
|---|---|---|
| Per-frame precision / recall per class | IoU ≥ 0.5 against the hand label, binned by `distanceM` (10 / 15 / 20 / curb) and `timeOfDay` | diagnostic (which bin fails: model or geometry?) |
| **False-WALK precision** | emitted WALK states whose target-head truth is WALK, over all emitted WALK states; hand, countdown, unlit and "target not visible" all count as false | **> 95 %** |
| **Recall (WALK, HAND)** | fraction of ground-truth spans ≥ 2 s at 10–20 m during which the matching state was emitted at least once within 1 s of onset | **> 80 %** |
| **Parallel-signal confusion** | emitted non-UNKNOWN states on the perpendicular-only clips (`targetVisible=false, perpVisible=true`) with the bearing set to the target crossing, over all frames in those clips | **< 2 %** |
| Onset correctness | every DONT_WALK→WALK truth transition yields exactly one `fresh: true`; a clip started mid-WALK yields `fresh: false` | all |
| Signal-model fps (APPROACH profile, COCO + depth running) | `getStats().detectorFps` for the signal model on the warm phone | **≥ 15** |
| Frame → `onSignalState` change | DebugPanel `frameToEventMs` | < 100 ms |

If the raw detector finds the perpendicular head (it should) but the gate passes it, the fix
is in 09 §5.1, not in training. If 20 m fails at 1280×720 and 1920×1080 is available, that is
a capture-format change for Agent C, not a retrain.

## Record

Every number goes into `eval/ped-signal-v1-device.csv`:

```
date,phone,iosVersion,captureFormat,buildId,thermalState,heldOutCrossing,distanceBin,timeOfDay,class,precision,recall,falseWalkPrecision,perpConfusion,signalFps,frameToEventMs,notes
```

One row per (distance bin × time of day × class) for the detector level, plus one summary row
(class `ALL`) carrying `falseWalkPrecision`, `perpConfusion`, `signalFps`, `frameToEventMs`.
Then D updates the manifest to `measuredOn: device` and sends it; Agent C commits it under
`models/`. Repeat at integration start with the final module build — models do not change,
but capture formats, thermal state and module code do.

## Looming filter (COCO, 10 §8)

Not mAP. Against `eval/vehicle-events.csv` (`clip,startS,endS,direction,notes`, hand-labelled
approaching-vehicle spans on the curb footage): false STOPs per 5 minutes of curb footage
(budget < 1) and STOP within 1 s of a labelled approach on the majority of events. Agent C
exports the `onVehicleApproaching` emissions per clip in the same `clip,tS,…` shape; D
counts. Threshold moves (growth, track age) are C's in 09 §5.2; one pass, then the cut order
applies.
