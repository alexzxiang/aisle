#!/usr/bin/env bash
# Peak compression and loudness normalization; hash-checked to avoid re-encoding.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }
exec npx tsx scripts/normalize-audio.ts "$@"
