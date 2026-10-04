#!/usr/bin/env bash
# Restart the NaviSync production server cleanly:
#   - kills every bun ./build/index.js instance (zombie workers steal queue jobs!)
#   - waits until the port is actually free
#   - starts exactly one fresh instance and waits for /api/health
# Usage: bash scripts/restart.sh [--build]
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-7158}"

# 1. Kill all instances (our shell's own cmdline may contain the pattern —
#    use pkill -f with the exact binary path + exclude ourselves via setsid).
pkill -f 'bun ./build/index.js' 2>/dev/null || true
for _ in $(seq 1 20); do
	pgrep -f 'bun ./build/index.js' >/dev/null 2>&1 || break
	sleep 0.5
done

# 2. Wait for the port to be free
for _ in $(seq 1 20); do
	if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
		sleep 0.5
	else
		break
	fi
done

# 3. Optional rebuild
if [ "${1:-}" = "--build" ]; then
	echo '[restart] building…'
	bun run build >/dev/null 2>&1
fi

# 4. Start exactly one instance
setsid nohup bun ./build/index.js >>logs/server.log 2>&1 < /dev/null &

# 5. Wait for health
for _ in $(seq 1 30); do
	if curl -sf "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
		echo "[restart] healthy on :${PORT} (pid $(pgrep -f 'bun ./build/index.js' | head -1))"
		exit 0
	fi
	sleep 0.5
done

echo '[restart] FAILED — server did not become healthy' >&2
tail -20 logs/server.log >&2 || true
exit 1
