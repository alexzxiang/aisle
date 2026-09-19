# Licences used by the CV training track

Rule (10 §3.1): every framework, pretrained weight and dataset is recorded here **before** a
single image is downloaded, with the licence string as published and the date. CC BY / CC0 /
MIT are fine; CC BY-NC is fine for this non-commercial hackathon prototype and must be
stated; "unknown" or all-rights-reserved means do not use. The handoff PR copies the relevant
rows into `models/LICENSES.md` (Agent C's file).

## Frameworks and pretrained weights

| Component | Licence | Source | Recorded | Notes |
|---|---|---|---|---|
| Ultralytics (YOLO11 code + `yolo11n.pt` COCO weights) | AGPL-3.0 **[verify current terms at download]** | https://github.com/ultralytics/ultralytics | 2026-09-18 | Framework and the COCO vehicle detector's weights. AGPL applies to the framework and derived weights; this prototype's source is open. |
| coremltools | BSD-3-Clause | https://github.com/apple/coremltools | 2026-09-18 | Conversion only. |
| PyTorch / torchvision | BSD-3-Clause | https://pytorch.org | 2026-09-18 | |
| OpenCV (opencv-python-headless) | Apache-2.0 | https://github.com/opencv/opencv-python | 2026-09-18 | Frame cropping. |
| Albumentations | MIT | https://github.com/albumentations-team/albumentations | 2026-09-18 | Optional augmentation. |
| Depth Anything V2 small (CoreML build) | **[verify]** expected Apache-2.0 for the small variant; larger variants CC BY-NC-4.0 | **[verify repository]** | pending | 10 §8 — record the exact build's licence before the §6 PR; if only a non-commercial build exists, state it. |

## Datasets

No public dataset has been downloaded yet. Fill one row per set **before** downloading;
delete this sentence when the first row lands.

| Dataset | Licence | Project URL | Downloaded | Images used | Role | Sanity check (50 random) |
|---|---|---|---|---|---|---|
| _example: Roboflow Universe "<project>"_ | _CC BY 4.0_ | _https://universe.roboflow.com/…_ | _YYYY-MM-DD_ | _n_ | _positives_ | _US heads, lens boxes — pass_ |

Excluded by rule, do not add: ImVisible / LYTNet (PTL) and derivatives (non-US
red/green person signals); LISA / Bosch / BSTLD-class vehicle-light sets **as positives**
(a slice may appear above with role `negatives`).

## Local capture

| Capture | Owner | Consent | Notes |
|---|---|---|---|
| `data/raw/<crossingId>/…` (demo crossings, Pittsburgh public sidewalks) | Team (named human per session in `data/manifest.csv`) | Public sidewalk, no permission needed; private property asked first | Bystander faces: frames with a legible face are dropped at selection (10 §3.3). Raw video stays on the team drive. |
| Store walkthrough video and aisle stills | Team | Store manager asked before filming (00 "Privacy") | Fixtures pipeline, not training. |
