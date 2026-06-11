#!/usr/bin/env zsh
# Mux audio from local source MOVs into existing server mp4s (video stream copied, no re-encode).
# Usage: zsh scripts/mux-audio.sh
# Requires: ffmpeg, ssh key auth to root@192.168.68.50

set -euo pipefail

LOCAL_DIR="/Users/robbintapper/Desktop/frame"
REMOTE_HOST="root@192.168.68.50"
REMOTE_DIR="/opt/slideshow/photos"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Audio mux: local → server ==="
echo "Temp dir: $TMP_DIR"
echo

# Get list of server mp4s
SERVER_FILES=("${(@f)$(ssh "$REMOTE_HOST" "ls $REMOTE_DIR/*.mp4 2>/dev/null")}")

MUXED=0
SKIPPED=0
NO_SOURCE=0

for remote_path in "${SERVER_FILES[@]}"; do
  server_name="$(basename "$remote_path")"          # e.g. IMG_1718.mp4
  stem="${server_name%.mp4}"                         # e.g. IMG_1718
  # Normalize trailing _2 suffix back to " 2" for local lookup
  local_stem="${stem%_2}"
  [[ "$local_stem" != "$stem" ]] && local_stem="${local_stem} 2"

  # Find matching local file (case-insensitive extension)
  local_src=""
  for ext in MOV mov MP4 mp4 m4v M4V; do
    candidate="$LOCAL_DIR/${local_stem}.${ext}"
    if [[ -f "$candidate" ]]; then
      local_src="$candidate"
      break
    fi
  done

  if [[ -z "$local_src" ]]; then
    echo "  [NO SOURCE] $stem — no local file found, skipping"
    (( NO_SOURCE++ )) || true
    continue
  fi

  # Check if local source has audio
  has_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type \
    -of default=noprint_wrappers=1:nokey=1 "$local_src" 2>/dev/null || true)
  if [[ -z "$has_audio" ]]; then
    echo "  [NO AUDIO]  $stem — source has no audio track, skipping"
    (( SKIPPED++ )) || true
    continue
  fi

  # Check if server file already has audio
  server_tmp="$TMP_DIR/${server_name}"
  scp -q "$REMOTE_HOST:$remote_path" "$server_tmp"

  already_audio=$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_type \
    -of default=noprint_wrappers=1:nokey=1 "$server_tmp" 2>/dev/null || true)
  if [[ -n "$already_audio" ]]; then
    echo "  [HAS AUDIO] $stem — server file already has audio, skipping"
    (( SKIPPED++ )) || true
    continue
  fi

  echo "  [MUXING]    $stem"
  echo "              source: $(basename "$local_src")"

  out_tmp="$TMP_DIR/out_${server_name}"

  # -c:v copy  → no video re-encode
  # -c:a aac -b:a 128k → re-encode audio from source
  # -shortest  → trim to shorter of video/audio (handles slight duration mismatches)
  ffmpeg -y -loglevel error \
    -i "$server_tmp" \
    -i "$local_src" \
    -map 0:v:0 -map 1:a:0 \
    -c:v copy \
    -c:a aac -b:a 128k \
    -shortest \
    -movflags +faststart \
    "$out_tmp"

  # Upload back
  scp -q "$out_tmp" "$REMOTE_HOST:$remote_path"
  echo "              → uploaded"
  (( MUXED++ )) || true
done

echo
echo "=== Done ==="
echo "  Muxed:      $MUXED"
echo "  Skipped:    $SKIPPED"
echo "  No source:  $NO_SOURCE"
