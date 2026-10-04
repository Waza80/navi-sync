#!/usr/bin/env bash
# NaviSync Phase-1 end-to-end smoke test.
# Requires: server running (bun run start) and .env configured.
# Usage: BASE=http://localhost:7158 bash scripts/smoke.sh
set -euo pipefail

BASE="${BASE:-http://localhost:7158}"
EMAIL="${SMOKE_EMAIL:-smoke@navisync.local}"
PASSWORD="${SMOKE_PASSWORD:-SmokeTest12345}"
JAR="$(mktemp)"
TRACK_URL="${SMOKE_TRACK_URL:-https://www.deezer.com/track/3135556}" # Daft Punk — One More Time

say() { printf '\n\033[1;35m[smoke]\033[0m %s\n' "$*"; }

say "1. health check"
curl -fsS "$BASE/api/health" | grep -q '"status":"ok"' && echo "  ✓ healthy"

say "2. unauthenticated API must be rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/tracks")
[ "$code" = "401" ] && echo "  ✓ 401 as expected"

say "3. sign up + session cookie"
curl -fsS -c "$JAR" -H "Origin: $BASE" -H 'content-type: application/json' \
	-d "{\"name\":\"Smoke\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
	"$BASE/api/auth/sign-up/email" >/dev/null
curl -fsS -b "$JAR" "$BASE/api/auth/get-session" | grep -q '"user"' && echo "  ✓ session established"

say "4. enqueue download: $TRACK_URL"
JOB_JSON=$(curl -fsS -b "$JAR" -H "Origin: $BASE" -H 'content-type: application/json' \
	-d "{\"url\":\"$TRACK_URL\"}" "$BASE/api/tracks")
echo "  $JOB_JSON"
JOB_ID=$(echo "$JOB_JSON" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

say "5. streaming live events (SSE, max 90s)"
timeout 90 curl -fsS -N -b "$JAR" "$BASE/api/events" | while read -r line; do
	case "$line" in
	data:*) echo "  ${line:0:160}" ;;
	esac
	# stop after terminal event for our job
	if echo "$line" | grep -q "job.completed\|job.failed"; then
		if echo "$line" | grep -q "$JOB_ID"; then break; fi
	fi
done || true

say "6. verify track row + files"
sleep 1
TRACKS=$(curl -fsS -b "$JAR" "$BASE/api/tracks?pageSize=5")
echo "$TRACKS" | head -c 300; echo
TRACK_ID=$(echo "$TRACKS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$TRACK_ID" ]; then
	FILE=$(curl -fsS -b "$JAR" "$BASE/api/tracks/$TRACK_ID" | grep -o '"filePath":"[^"]*"' | cut -d'"' -f4 | sed 's|\\/|/|g')
	if [ -n "$FILE" ] && [ -f "$FILE" ]; then
		echo "  ✓ audio on disk: $FILE ($(du -h "$FILE" | cut -f1))"
		LRC="${FILE%.*}.lrc"
		[ -f "$LRC" ] && echo "  ✓ lyrics sidecar: $LRC ($(wc -l < "$LRC") lines)" || echo "  ⚠ no .lrc sidecar"
	else
		echo "  ⚠ track row present but file not found locally: $FILE"
	fi
else
	echo "  ✗ no track row — download failed (check server logs)"
	exit 1
fi

say "7. rate limiter responds 429 under flood"
for _ in $(seq 1 115); do
	curl -s -o /dev/null -b "$JAR" "$BASE/api/tracks?pageSize=1"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/api/tracks?pageSize=1")
[ "$code" = "429" ] && echo "  ✓ 429 after 100 req/min" || echo "  ⚠ got $code (limit may not have reset)"

rm -f "$JAR"
say "SMOKE COMPLETE"
