#!/usr/bin/env bash
# Build Aisle for the iPhone plugged into this Mac and install it, or just compile.
#
#   npm run ios:check            compile the app + native module without a device (catches Swift errors)
#   npm run ios:device           build for the connected iPhone, install and launch
#   npm run ios:device -- --clean   also regenerate ios/ (expo prebuild --clean) first
#
# What it does, so the steps are reproducible by hand (HANDOFF.md "Rebuilding"):
#   1. `expo prebuild` if ios/ is missing (or --clean): generates the Xcode project from app.json + plugins.
#   2. `pod install`: the Perception module is a local pod whose file list is a glob — a new .swift
#      file is not compiled until this runs.
#   3. `xcodebuild` with automatic signing (team from plugins/withAutomaticSigning.js).
#   4. `devicectl` install + launch on the first connected iPhone.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-device}"; shift || true
CLEAN=0
for a in "$@"; do [ "$a" = "--clean" ] && CLEAN=1; done

DD=/tmp/aisle-dd
SCHEME=Aisle
BUNDLE_ID=edu.steelhacks.aisle

if [ "$CLEAN" = 1 ] || [ ! -d ios ]; then
  echo "▶ expo prebuild (ios)"; npx expo prebuild --platform ios ${CLEAN:+--clean} --no-install
fi
echo "▶ pod install"; (cd ios && pod install --silent)

if [ "$MODE" = "check" ]; then
  echo "▶ xcodebuild (compile only, no signing)"
  xcodebuild -workspace ios/Aisle.xcworkspace -scheme "$SCHEME" -configuration Debug \
    -destination 'generic/platform=iOS' -derivedDataPath "$DD" \
    CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build 2>&1 | grep -E "error:|warning: .*Perception|BUILD (SUCCEEDED|FAILED)" || true
  exit "${PIPESTATUS[0]}"
fi

DEVICE_ID=$(xcrun devicectl list devices --json-output /tmp/aisle-devices.json >/dev/null 2>&1 && \
  python3 -c "import json; d=json.load(open('/tmp/aisle-devices.json')); ds=[x for x in d['result']['devices'] if x.get('hardwareProperties',{}).get('deviceType')=='iPhone' and x.get('connectionProperties',{}).get('tunnelState')!='unavailable']; print(ds[0]['hardwareProperties']['udid'] if ds else '')")
if [ -z "$DEVICE_ID" ]; then
  echo "✗ No iPhone reachable. Plug it in with a cable, unlock it, tap Trust, then rerun." >&2
  xcrun devicectl list devices 2>/dev/null | sed -n '1,6p' >&2
  exit 2
fi
echo "▶ building for device $DEVICE_ID"
xcodebuild -workspace ios/Aisle.xcworkspace -scheme "$SCHEME" -configuration Debug \
  -destination "id=$DEVICE_ID" -allowProvisioningUpdates -derivedDataPath "$DD" build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" || true
APP="$DD/Build/Products/Debug-iphoneos/$SCHEME.app"
[ -d "$APP" ] || { echo "✗ build produced no app at $APP" >&2; exit 1; }
echo "▶ installing"; xcrun devicectl device install app --device "$DEVICE_ID" "$APP"
echo "▶ launching"; xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" || true
echo "✓ done. Start Metro with: npx expo start --dev-client"
