#!/usr/bin/env bash
# Complete public-schema chain with synthetic data, only on a disposable localhost container.
set -euo pipefail
cd "$(dirname "$0")/../../.."
container="jopie-semantic-baseline-test"
# A pre-existing name is an error; do not remove a container this script did not create.
docker run -d --name "$container" -e POSTGRES_PASSWORD=synthetic-local-only postgres:17-alpine >/dev/null
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
for attempt in {1..30}; do
    if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep 1
done
docker exec "$container" createdb -U postgres jopie_baseline_test
docker exec -i "$container" psql -U postgres -d jopie_baseline_test -v ON_ERROR_STOP=1 < supabase/fixtures/semantic-entry-auth-bootstrap.sql >/dev/null
for migration in supabase/migrations/*.sql; do
    docker exec -i "$container" psql -U postgres -d jopie_baseline_test -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i "$container" psql -U postgres -d jopie_baseline_test -v ON_ERROR_STOP=1 < supabase/tests/semantic-entry-baseline.sql
