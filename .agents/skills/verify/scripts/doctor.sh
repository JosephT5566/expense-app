#!/usr/bin/env bash
# Read-only: is the instance on 4173 ours, current, and built with synthetic env?
set -uo pipefail
source "$(dirname "$0")/common.sh"
fail=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; fail=1; }
if [ ! -f "$STATE" ]; then
	bad "no state file $STATE (nothing launched by verify)"
	[ -n "$(listener_pids)" ] && bad "port $PORT is held by a process verify did not start"
	exit 1
fi
source "$STATE"
if kill -0 "$PID" 2>/dev/null && grep -q 'vite.js preview' <<<"$(ps -o command= -p "$PID")"; then ok "pid $PID is vite preview"; else bad "pid $PID is not a running vite preview"; fi
[ "$(listener_pids)" = "$PID" ] && ok "port $PORT owned by pid $PID" || bad "port $PORT listeners: '$(listener_pids | tr '\n' ' ')' (expected $PID)"
grep -q 'Loading JoPie' <<<"$(curl -fsS "$URL/" 2>/dev/null)" && ok "$URL serves JoPie" || bad "$URL does not serve JoPie"
cd "$ROOT"
[ -n "$(grep -rl 'verify-stub.invalid' build/_app 2>/dev/null | head -1)" ] && ok "build uses synthetic Supabase URL" || bad "build lacks synthetic Supabase URL (stale or real-env build)"
# Count only; never print matches, they could be the real project host.
real=$(grep -rEoh 'https://[a-z0-9-]+\.supabase\.co' build .svelte-kit/output 2>/dev/null | sort -u | wc -l | tr -d ' ')
[ "$real" = 0 ] && ok "no *.supabase.co host in build output" || bad "$real *.supabase.co host(s) in build output; rebuild with launch.sh"
for host in semantic.verify.invalid receipt.verify.invalid; do
	grep -rqs "$host" build .svelte-kit/output && ok "build references $host" || bad "build lacks $host"
done
git check-ignore -q test-results/verify && ok "evidence root is git-ignored" || bad "test-results/verify is not git-ignored"
exit $fail
