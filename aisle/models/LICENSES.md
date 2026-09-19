# models/LICENSES.md — per-model and per-dataset licences

Every artifact under `models/` carries one entry here before it merges (10 §6). No entry,
no merge. Weights themselves are not committed at this revision; the rows below record what
each expected file will carry and what must be verified on delivery.

| Artifact | Licence | Notes |
|---|---|---|
| `coco-yolo-nano.mlpackage`, `coco-yolo-nano-416.mlpackage` | AGPL-3.0 (Ultralytics YOLO11 / YOLOv8 pretrained weights) | Hackathon prototype, source published; weights are downloaded and exported by the training track, not vendored. Trained on COCO (CC BY 4.0 annotations). |
| `ped-signal-v1.mlpackage` | Model: same base licence as the pretrained YOLO nano it starts from. Datasets: listed per source in `training/LICENSES.md` (public pedestrian-signal sets plus local frames captured by the team). | D delivers the dataset table with the PR; C copies the summary line here on merge. |
| `depth-anything-v2-small.mlpackage` | Apache-2.0 expected for the Small variant **[verify on the day]**; Base / Large are CC BY-NC-4.0 and are not to be used. | Record the exact repository and commit of the CoreML conversion on delivery. |
| `walkable-seg.mlpackage` (optional) | As exported; Cityscapes-trained models carry the Cityscapes research licence — confirm before use. | Off by default; no gate depends on it. |
| Apple Vision OCR | System framework | No file. |

Attribution lines for the README / slides (06 "Failure-mode checklist"): Ultralytics YOLO,
Depth Anything V2 (HKU / TikTok), ElevenLabs, and the pedestrian-signal datasets named in
`training/LICENSES.md`.
