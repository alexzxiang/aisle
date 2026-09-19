# Perception and voice pipeline review

Reviewed after integrating upstream adaptive search (274122f) and the unseen-food changes.

## Data flow

1. The native ARKit camera feeds CoreML detection, Vision image classification, OCR, depth, and hand tracking. `PerceptionService` exposes those event streams to JavaScript.
2. `composeApp` sends detections to geometry and scene memory. Classifier labels supply image-wide identity hints; they do not supply item boxes. Detector and classifier records remain separate, with detector positions preferred when available.
3. `semanticVision` captures a still and sends current evidence over HTTP to the proxy. Detection facts expire after 1.5 seconds, depth after one second, OCR and signals after three seconds, and classifier labels after four seconds. Remembered search bearings have a separate lifetime and are not presented as current detections.
4. The proxy builds the vision prompt and coerces the model result. Both proxy and phone reject zero-area and out-of-frame target boxes using the shared search-box validator.
5. `guidedTask`, `itemMission`, and adaptive search consume accepted results. Search hypotheses choose places to inspect; visible item evidence supplies geometry. Fridge retrieval retains opening, identification, hand guidance, and explicit pickup confirmation checkpoints. Silent task requests let the task controller own spoken instructions.
6. The speech facade normalizes spoken text. The speech queue applies mode, priority, pacing, and duplicate rules, then uses cached audio, proxy TTS, or the device speech fallback. WebSocket streaming remains intentionally disabled in production composition because its binary-audio playback relay is unavailable.

## Repairs from this review

- Expire cached perception facts consistently for request construction, scene gating, and `getFacts` consumers.
- Reject unusable target geometry at both response boundaries.
- Prevent a detector sighting from merging into an image-wide classifier record while retaining classifier provenance.
- Preserve upstream adaptive search when integrating the likely-fridge fallback.

## Validation

- App: 84 suites, 1,278 tests passed.
- Server: 23 suites, 215 tests passed.
- App lint (TypeScript, dependencies, phrases) and server TypeScript passed.
- Native engine check attempted but unavailable: iPhoneOS SDK is not installed.
- No live camera, model-provider, microphone, or speaker validation was performed. These checks establish software behavior, not real-world recognition accuracy.
