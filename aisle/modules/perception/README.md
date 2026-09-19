# `Perception` — the native module (Agent C)

The only camera client in Aisle: one ARKit `ARSession`, the on-device models, every temporal
filter, and rate-limited events to JS. Spec: [`09-PERCEPTION-MODULE.md`](../../../09-PERCEPTION-MODULE.md);
event and method names: `01-SHARED-CONTRACTS.md` §7.

```
modules/perception/
  index.ts                     typed bridge: requireOptionalNativeModule('Perception'), event unwrapping,
                               getPerceptionPreviewView() for the native preview
  expo-module.config.json      autolinks PerceptionModule on iOS
  ios/PerceptionModule.swift   Expo Modules DSL wrapper (imports ExpoModulesCore; wires, never filters)
  ios/PerceptionPreviewView.swift  ExpoView + ARSCNView on the engine's session (see below)
  ios/Engine/*.swift           the engine — no ExpoModulesCore; typechecks on a Mac:
                               xcrun -sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 -parse-as-library ios/Engine/*.swift
  tests/run.sh                 09 §10 unit checks for the pure engine files
```

The JS `PerceptionService` (01 §7) lives in `src/perception/PerceptionService.ts`; App.tsx
picks it or D's replayer (`EXPO_PUBLIC_MOCK=1`), and nothing below knows the difference.

## Preview view

`PerceptionPreviewView` shows what the camera sees without a second camera session: an
`ARSCNView` whose `session` is `PerceptionEngine.arSession` (read-only). Empty scene, no
lighting updates, camera background only. Props and events:

| | |
|---|---|
| `mirror: Bool` | horizontal flip, default `false` (rear camera) |
| `onReady` | once per attach: `{ attached: true, running: Bool }` — `running == false` means black until `start()` |

Behaviour to expect, by design:

- **Attaching never changes the session** — no configuration, no `run`/`pause`, no delegate
  change. The engine stays the delegate (the view restores it if ARKit touched it).
- **Black before `start(profile)`**: the session has no frames yet.
- **Frozen in IDLE**: the IDLE profile pauses the session (09 §9), so the preview holds the
  last frame and resumes with the next non-IDLE profile.
- **Deinit hands the ARSCNView a throw-away session**, so a dying view cannot release or
  pause the engine's session.

JS side: `getPerceptionPreviewView()` (this folder's `index.ts`) returns the native component
or `null` when it is not linked; `src/perception/CameraPreview.tsx` is the component the UI
uses — native view plus the `onDetections` overlay, or a "Camera preview" placeholder with
the replayer's last frame in mock mode / unlinked builds. Pass `mock` from the composition
root in mock mode: the replayer never starts the engine, so the native view would stay black.

A native change: rebuild the dev client (`npx expo run:ios --device`; `pod install` picks up
the new Swift file through the podspec glob).
