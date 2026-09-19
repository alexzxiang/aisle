#!/usr/bin/env bash
# 09 §10 unit checks for the PerceptionModule engine, on a Mac, no device, no Xcode project.
#
# Compiles the ARKit-free engine files (Events, Filters, SignalDetector, VehicleTracker,
# ObstacleEstimator, ModelRegistry, OcrReader, Geometry) together with EngineChecks.swift
# against the macOS SDK and runs the checks. ARSessionManager / PerceptionEngine / Snapshot
# import ARKit and are covered by the iOS typecheck instead:
#   xcrun -sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 -parse-as-library ios/Engine/*.swift
#
# Usage: modules/perception/tests/run.sh          (from anywhere)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
engine="$here/../ios/Engine"
out="${TMPDIR:-/tmp}/aisle-engine-checks"
mkdir -p "$out"

pure=(
  "$engine/Events.swift"
  "$engine/Filters.swift"
  "$engine/Geometry.swift"
  "$engine/SignalDetector.swift"
  "$engine/VehicleTracker.swift"
  "$engine/ObstacleEstimator.swift"
  "$engine/ModelRegistry.swift"
  "$engine/OcrReader.swift"
)

echo "== iOS typecheck of the whole engine =="
xcrun -sdk iphoneos swiftc -typecheck -target arm64-apple-ios17.0 -parse-as-library "$engine"/*.swift

echo "== macOS build of the pure engine + checks =="
xcrun -sdk macosx swiftc -parse-as-library -O "${pure[@]}" "$here/EngineChecks.swift" -o "$out/engine-checks"

echo "== run =="
"$out/engine-checks"
