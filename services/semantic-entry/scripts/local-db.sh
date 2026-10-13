#!/usr/bin/env bash
# Isolated synthetic PostgreSQL/PostgREST fallback; no live database connection.
set -euo pipefail
cd "$(dirname "$0")/../../.."
# Stable dedicated names/ports deliberately fail if an unrelated container owns them.
docker run -d --name jopie-semantic-test-db -e POSTGRES_PASSWORD=synthetic-local-only -p 127.0.0.1:55422:5432 postgres:17-alpine >/dev/null
for attempt in {1..30}; do
  if docker exec jopie-semantic-test-db pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i jopie-semantic-test-db psql -U postgres -v ON_ERROR_STOP=1 < supabase/fixtures/semantic-entry-auth-bootstrap.sql
docker exec -i jopie-semantic-test-db psql -U postgres -v ON_ERROR_STOP=1 < supabase/fixtures/semantic-entry-test-schema.sql
docker run -d --name jopie-semantic-test-rest --link jopie-semantic-test-db:db -p 127.0.0.1:55421:3000 -e PGRST_DB_URI=postgres://authenticator:synthetic-local-only@db:5432/postgres -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET=synthetic-local-test-secret-at-least-32-characters postgrest/postgrest:v13.0.7 >/dev/null
