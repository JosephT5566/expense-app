#!/usr/bin/env bash
# Stop only the preview this skill started. Never deletes evidence.
set -uo pipefail
source "$(dirname "$0")/common.sh"
if [ ! -f "$STATE" ]; then
	echo "nothing to clean (no $STATE)"
	[ -n "$(listener_pids)" ] && echo "WARN: port $PORT held by pid $(listener_pids | tr '\n' ' '), not started by verify; left alone"
	exit 0
fi
source "$STATE"
if kill -0 "$PID" 2>/dev/null && grep -q 'vite.js preview' <<<"$(ps -o command= -p "$PID")"; then
	kill "$PID"
	for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
	kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
	echo "stopped pid $PID"
else
	echo "pid $PID already gone or not vite preview; not killing"
fi
rm -f "$STATE"
[ -n "$(listener_pids)" ] && echo "WARN: port $PORT still held by $(listener_pids | tr '\n' ' ')" || echo "port $PORT free"
echo "evidence kept: $OUT"
