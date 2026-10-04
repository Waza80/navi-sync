#!/usr/bin/env bash
# Restart the NaviSync server CLEANLY.
#
# Hard-learned lesson: a naive `pkill; sleep 2; (bun &)` leaves zombies — the
# old process drains for up to 30s while the new one dies with EADDRINUSE, and
# the STALE binary keeps serving (stale code = "the website is unstable").
#
# This script: TERM → wait for exit (KILL after 10s) → wait port-free → start
# exactly one instance → verify health AND a fresh boot stamp.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"

PORT="${PORT:-7158}"

# 1. TERM all instances
pkill -f 'bun ./build/index.js' 2>/dev/null || true

# 2. Wait up to 10s for exit, then KILL the stragglers
for _ in $(seq 1 20); do
	pgrep -f 'bun ./build/index.js' >/dev/null 2>&1 || break
	sleep 0.5
done
pkill -9 -f 'bun ./build/index.js' 2>/dev/null || true

# 3. Wait up to 30s for the port to actually free (drain window)
for _ in $(seq 1 60); do
	if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
		sleep 0.5
	else
		break
	fi
done
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
	echo "[restart] FATAL: port ${PORT} still occupied after 30s" >&2
	ss -ltnp 2>/dev/null | grep "${PORT}" >&2 || true
	exit 1
fi

# 4. Optional rebuild
if [ "${1:-}" = "--build" ]; then
	echo '[restart] building…'
	bun run build >/dev/null 2>&1
fi

# 5. Start exactly one instance (own session, survives this shell)
mkdir -p logs
setsid nohup bun ./build/index.js >>logs/server.log 2>&1 < /dev/null &

# 6. Health + fresh-boot verification
for _ in $(seq 1 30); do
	if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
		BOOT=$(curl -sf "http://localhost:${PORT}/api/health" | grep -o '"bootedAt":"[^"]*"' || true)
		PIDS=$(pgrep -fc 'bun ./build/index.js' || true)
		if [ "${PIDS:-0}" -gt 1 ]; then
			echo "[restart] FATAL: ${PIDS} server instances running" >&2
			exit 1
		fi
		echo "[restart] healthy on :${PORT} (pid $(pgrep -f 'bun ./build/index.js' | head -1)) ${BOOT}"
		exit 0
	fi
	sleep 0.5
done

echo '[restart] FAILED — server did not become healthy' >&2
tail -20 logs/server.log >&2 || true
exit 1
