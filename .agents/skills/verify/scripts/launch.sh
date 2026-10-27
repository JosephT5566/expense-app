#!/usr/bin/env bash
# Build with synthetic env and start `vite preview` on 4173. Usage: launch.sh [run-id]
set -euo pipefail
source "$(dirname "$0")/common.sh"
if [ -n "$(listener_pids)" ]; then
	echo "REFUSE: port $PORT already has a listener (pid $(listener_pids | tr '\n' ' ')). Not started by this run; do not drive it." >&2
	exit 2
fi
if [ -f "$STATE" ]; then
	echo "REFUSE: stale state $STATE. Run cleanup.sh first." >&2
	exit 2
fi
RUN_ID="${1:-$(date +%Y%m%d-%H%M%S)}"
OUT="$EVIDENCE_ROOT/$RUN_ID"
mkdir -p "$OUT"
cd "$ROOT"
echo "building (log: $OUT/build.log)"
if ! npm run build >"$OUT/build.log" 2>&1; then
	echo "FAIL: build failed; see $OUT/build.log" >&2
	exit 1
fi
# Same as `npm run preview`, but without the npm wrapper so $! is the listener.
nohup node node_modules/vite/bin/vite.js preview --port "$PORT" --strictPort >"$OUT/preview.log" 2>&1 &
PID=$!
printf 'PID=%s\nRUN_ID=%s\nOUT=%s\nURL=http://localhost:%s\nSUPABASE=%s\nSEMANTIC=%s\nRECEIPT=%s\n' \
	"$PID" "$RUN_ID" "$OUT" "$PORT" "$PUBLIC_SUPABASE_URL" "$PUBLIC_SEMANTIC_ENTRY_URL" "$PUBLIC_GOOGLE_AI_GCF" >"$STATE"
for _ in $(seq 1 60); do
	if grep -q 'Loading JoPie' <<<"$(curl -fsS "http://localhost:$PORT/" 2>/dev/null)"; then
		echo "READY pid=$PID url=http://localhost:$PORT run=$RUN_ID evidence=$OUT"
		exit 0
	fi
	kill -0 "$PID" 2>/dev/null || break
	sleep 0.5
done
echo "FAIL: preview not ready; see $OUT/preview.log. Run cleanup.sh." >&2
exit 1
