#!/usr/bin/env bash
# Bring every cached phrase to the loudness of the live ElevenLabs stream.
#
# Measured 2026-09-19: cached phrases sat at −25…−37 dB mean / −9…−22 dB peak while a live
# TTS clip through /api/tts measured −19.8 dB mean / −0.9 dB peak. On the walk almost every
# line is a cached phrase, so "the voice is quiet on route". EBU R128 loudnorm to −16 LUFS,
# true peak −1.5 dB, re-encoded at the manifest's 64 kbps CBR. Idempotent: running it twice
# changes nothing audible. The manifest's textSha1 keys the text, not the bytes, so it stays
# valid; `bytes` / `estimatedMs` are refreshed by `npm run gen:audio` (which calls this).
set -euo pipefail
cd "$(dirname "$0")/../assets/audio"
command -v ffmpeg >/dev/null || { echo "ffmpeg not found (brew install ffmpeg)"; exit 1; }
n=0
for f in *.mp3; do
  tmp="${f%.mp3}.norm.mp3"
  ffmpeg -hide_banner -loglevel error -y -i "$f" \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11" -ar 44100 -ac 1 -codec:a libmp3lame -b:a 64k "$tmp"
  mv "$tmp" "$f"
  n=$((n+1))
done
echo "normalized $n phrases to -16 LUFS / -1.5 dBTP"
