#!/usr/bin/env bash
# Complete public-schema chain with synthetic data, only on a disposable localhost container.
set -euo pipefail
cd "$(dirname "$0")/../../.."
container="jopie-semantic-baseline-test"
password="synthetic-local-only"
# A pre-existing name is an error; do not remove a container this script did not create.
docker run -d --name "$container" -e POSTGRES_PASSWORD="$password" postgres:17-alpine >/dev/null
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
ready=false
for attempt in {1..30}; do
    if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres -d postgres -t 1 >/dev/null 2>&1; then
        ready=true
        break
    fi
    sleep 1
done
if [[ "$ready" != true ]]; then
    echo "PostgreSQL did not become ready on TCP 127.0.0.1:5432 after 30 attempts" >&2
    docker logs "$container" >&2 || true
    exit 1
fi
docker exec -e PGPASSWORD="$password" "$container" createdb -h 127.0.0.1 -U postgres jopie_baseline_test
docker exec -i -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d jopie_baseline_test -v ON_ERROR_STOP=1 < supabase/fixtures/semantic-entry-auth-bootstrap.sql >/dev/null
for migration in supabase/migrations/*.sql; do
    docker exec -i -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d jopie_baseline_test -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done
docker exec -i -e PGPASSWORD="$password" "$container" psql -h 127.0.0.1 -U postgres -d jopie_baseline_test -v ON_ERROR_STOP=1 < supabase/tests/semantic-entry-baseline.sql
