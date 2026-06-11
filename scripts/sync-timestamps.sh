#!/usr/bin/env zsh
# Sync creation_time metadata from local MOV source files to server mp4s.
# Reads com.apple.quicktime.creationdate (or creation_time) from local file,
# writes it as creation_time to the server mp4 via ffmpeg remux (no re-encode).
# Usage: zsh scripts/sync-timestamps.sh
# Requires: ffmpeg, ffprobe, ssh key auth to root@192.168.68.50

set -euo pipefail

LOCAL_DIR="/Users/robbintapper/Desktop/frame"
REMOTE_HOST="root@192.168.68.50"
REMOTE_DIR="/opt/slideshow/photos"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "=== Timestamp sync: local → server ==="
echo "Temp dir: $TMP_DIR"
echo

SERVER_FILES=("${(@f)$(ssh "$REMOTE_HOST" "ls $REMOTE_DIR/*.mp4 2>/dev/null")}")

SYNCED=0
SKIPPED=0
NO_SOURCE=0
NO_TS=0

for remote_path in "${SERVER_FILES[@]}"; do
  server_name="$(basename "$remote_path")"
  stem="${server_name%.mp4}"
  local_stem="${stem%_2}"
  [[ "$local_stem" != "$stem" ]] && local_stem="${local_stem} 2"

  # Find matching local file
  local_src=""
  for ext in MOV mov MP4 mp4 m4v M4V; do
    candidate="$LOCAL_DIR/${local_stem}.${ext}"
    if [[ -f "$candidate" ]]; then
      local_src="$candidate"
      break
    fi
  done

  if [[ -z "$local_src" ]]; then
    echo "  [NO SOURCE] $stem"
    (( NO_SOURCE++ )) || true
    continue
  fi

  # Extract creation timestamp from local file
  # Prefer com.apple.quicktime.creationdate (has timezone), fall back to creation_time (UTC)
  ts=$(ffprobe -v error \
    -show_entries format_tags=com.apple.quicktime.creationdate,creation_time \
    -of default=noprint_wrappers=1:nokey=1 \
    "$local_src" 2>/dev/null | head -1 | tr -d '[:space:]')

  if [[ -z "$ts" ]]; then
    echo "  [NO TS]     $stem — no timestamp in local file"
    (( NO_TS++ )) || true
    continue
  fi

  # Normalize to UTC ISO8601 for creation_time tag
  # com.apple.quicktime.creationdate may be like 2022-06-21T13:11:04+0200
  # ffmpeg creation_time expects UTC: 2022-06-21T11:11:04Z
  # Use python3 to parse and convert
  ts_utc=$(python3 -c "
from datetime import datetime, timezone
import sys
s = '$ts'
# Try parsing with timezone offset
for fmt in ('%Y-%m-%dT%H:%M:%S%z', '%Y-%m-%dT%H:%M:%S.%f%z', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%dT%H:%M:%S.%fZ'):
    try:
        dt = datetime.strptime(s, fmt)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        print(dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
        sys.exit(0)
    except: pass
print(s)
" 2>/dev/null)

  if [[ -z "$ts_utc" ]]; then
    echo "  [BAD TS]    $stem — could not parse timestamp: $ts"
    (( NO_TS++ )) || true
    continue
  fi

  # Check if server file already has correct creation_time
  server_tmp="$TMP_DIR/${server_name}"
  scp -q "$REMOTE_HOST:$remote_path" "$server_tmp"

  existing_ts=$(ffprobe -v error \
    -show_entries format_tags=creation_time \
    -of default=noprint_wrappers=1:nokey=1 \
    "$server_tmp" 2>/dev/null | tr -d '[:space:]')

  if [[ "$existing_ts" == "$ts_utc" ]]; then
    echo "  [OK]        $stem — already has correct timestamp ($ts_utc)"
    (( SKIPPED++ )) || true
    continue
  fi

  echo "  [SYNCING]   $stem"
  echo "              $existing_ts → $ts_utc"

  out_tmp="$TMP_DIR/out_${server_name}"

  # Remux with updated creation_time — no re-encode
  ffmpeg -y -loglevel error \
    -i "$server_tmp" \
    -c copy \
    -map_metadata 0 \
    -metadata creation_time="$ts_utc" \
    -movflags +faststart \
    "$out_tmp"

  scp -q "$out_tmp" "$REMOTE_HOST:$remote_path"
  echo "              → uploaded"
  (( SYNCED++ )) || true
done

echo
echo "=== Done ==="
echo "  Synced:     $SYNCED"
echo "  Already OK: $SKIPPED"
echo "  No source:  $NO_SOURCE"
echo "  No TS:      $NO_TS"
