# Shared settings for the verify helpers. Source it; do not run it.
ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
PORT=4173
STATE="${TMPDIR:-/tmp}/expense-app-verify-$PORT.env"
EVIDENCE_ROOT="$ROOT/test-results/verify"

# Synthetic build-time configuration. `.invalid` never resolves, so a request
# that escapes the browser mocks still cannot reach a real service.
export PUBLIC_SUPABASE_URL=https://verify-stub.invalid
export PUBLIC_SUPABASE_PUBLISHABLE_KEY=verify-publishable-key
export PUBLIC_EMAIL_NAME_MAPPING='{}'
export PUBLIC_SEMANTIC_ENTRY_URL=https://semantic.verify.invalid
export BASE_PATH=''

listener_pids() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u; }
