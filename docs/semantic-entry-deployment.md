# Semantic entry service deployment

The service is implemented locally; hosted acceptance remains unverified. On 2026-10-13 the existing public schema and semantic objects were reviewed, migration history was adopted, and the tested citext trigger fix was applied to the user-designated Supabase project. See [scoped database evidence](evidence/semantic-entry/2026-10-13-database-baseline.md). Production metadata inspection and localhost transaction tests do not establish real-user hosted behavior. The service adapts JSONB metadata to the existing string wire contract and validates whole-TWD amounts against the actual numeric column capacity. Hosted acceptance remains unverified. Missing or unresolved categories require clarification before writing. Do not apply `supabase/fixtures/` to production.

## Local container

Use Python 3.12 and uv 0.12.7 (the frontend still uses Node 22):

```sh
uv sync --project services/semantic-entry --locked
uv run --directory services/semantic-entry --locked pytest
uv run --directory services/semantic-entry --locked ruff check .
uv run --directory services/semantic-entry --locked ruff format --check .
uv run --directory services/semantic-entry --locked mypy
docker build -f services/semantic-entry/Dockerfile -t jopie-semantic-entry .
services/semantic-entry/scripts/container-smoke.sh
```

The smoke test injects synthetic dependencies into the real HTTP server and graph. It verifies HTTP/container wiring without a paid model call or live database access. `/health` never calls the model. The Python 3.12 image runs as non-root `semantic` (UID 10001), listens on `0.0.0.0:$PORT` (default 8080), and copies only allowlisted Python source and locked runtime dependencies. Root `.env` files and test fixtures are excluded.

Start the service locally after configuring the backend environment values below:

```sh
uv run --directory services/semantic-entry --locked python -m semantic_entry.server
```

## Configuration

| Variable                    | Value                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| `SUPABASE_URL`              | Existing Supabase project HTTPS origin                                       |
| `SUPABASE_PUBLISHABLE_KEY`  | Publishable key; never a service-role key                                    |
| `GEMINI_API_KEY`            | Secret Manager secret exposed only to the backend                            |
| `SEMANTIC_MODEL`            | `gemini-3.5-flash-lite` by default                                           |
| `SEMANTIC_MEMBER_NAMES`     | JSON object of allowed email to display name; e.g. `{"a@example.test":"甲"}` |
| `SEMANTIC_ALLOWED_ORIGINS`  | Comma-separated exact frontend origins, without paths/trailing slash         |
| `PUBLIC_SEMANTIC_ENTRY_URL` | Frontend build value: Cloud Run origin; client appends `/semantic-entry`     |

The runtime validates Supabase JWTs through HTTPS `/auth/v1/user`, checks the settings allowlist, and sends the same caller JWT to HTTPS Data API/RPC. Cloud Run does not need a PostgreSQL password, direct DB connection, connection pool, or service-role credential. Public Cloud Run ingress and CORS are not authorization. Disable external LangSmith tracing; the server forcibly disables tracing environment flags and emits only sanitized events.

## Hosted setup (operator action, not performed)

Confirm project, region, budget, IAM permissions, Secret Manager access, actual schema/RLS compatibility, and available expense categories before deployment. Build/push the image to the chosen Artifact Registry repository. Deploy with request-based CPU billing, minimum zero instances, maximum two, one vCPU, 512 MiB memory, and a 30-second request timeout. Limit the runtime service account's secret access to the required secret only; do not grant project-wide secret access or database administration. Configure secrets with Secret Manager bindings, not plaintext committed environment files. Pin versions when releasing.

Set the frontend's public URL to the service origin, rebuild under the GitHub Pages base path, and configure the frontend origin in CORS. The backend uses the Gemini Developer API with an API key, not Vertex AI. The runtime account needs Secret Manager Secret Accessor on the Gemini key secret; it does not need Vertex AI permissions for this adapter. No member-name secret is required.

The service uses FastAPI with Uvicorn and accepts `POST /semantic-entry`, `GET /semantic-entry/:requestId`, `OPTIONS`, and `GET /health`. It uses one structured model call, an 800-token output cap, minimal thinking for the default model, a 15-second model deadline, and no model retries. The REST `generationConfig.responseFormat.text.mimeType` is the enum `APPLICATION_JSON`, not the MIME string `application/json`. [Gemini structured output reference](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) and [model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite).

The existing POST endpoint supports bounded clarification history and SSE events; clients requesting `Accept: text/event-stream; semantic-version=2` also receive bounded Gemini analysis fragments before the usual events. Unversioned clients retain the old event set, and ordinary JSON POST is unchanged. Analysis is informational; completeness and fixed questions remain rule-based. The provider retains one call per round, an 800-token output cap, and a 15-second total model deadline. Analysis and extraction must both fit that cap; hosted compatibility and latency still need authorized live verification.

The SSE lifecycle retains its existing behavior; no new agent endpoint or conversation table is required. See [wire and idempotency contracts](database.md#semantic-entry-service). The hosting path must forward `text/event-stream` incrementally without buffering. A `persisting` event precedes the RPC; accepted writes continue in an in-process task after response disconnection, subject to the request deadline and instance lifetime. Verify this on the hosted path, including proxy buffering, lost responses, cold starts, and instance shutdown. Only UUID recovery is stored by the browser.

Hosted acceptance still requires a verified-user smoke test, rejected-input zero-write checks, same-request concurrency, a lost-response retry, edited/deleted expense replay, cross-account isolation, real Taiwan-day quota behavior, subpath navigation/session propagation, observed logs without private data, cold start/deadline behavior, and budget/usage monitoring. Local mocks and container success do not establish these results. Paid live evaluation requires separate authorization and must never persist expenses.

## Error diagnostics

Cloud Run POST request logs can show HTTP 200 when an accepted SSE stream ends with `event: error`. Inspect the event's `error.code` and correlate structured application logs by `requestId`; transport status alone does not establish success.

Graph failures emit one sanitized structured log with `severity: ERROR`, `node`, `status: error`, `requestId`, `elapsedMs`, `errorCode`, and a fixed `errorMessage` summary. Semantic errors also include the application `httpStatus` and `uncertain` flag. Unexpected exceptions include their type, without raw exception text or traceback. Status lookup failures and request deadlines are logged separately; errors before a valid UUID is parsed omit `requestId`. Logging failures do not change request or accepted-write outcomes.

For Gemini non-success responses, logs include `upstreamHttpStatus`. An error body of at most 8 KiB can additionally supply an allowlisted `upstreamCode` and recognized `upstreamField`. For example, an invalid format enum identifies `generation_config.response_format.text.mime_type` and the summary `Gemini rejected parameter: generation_config.response_format.text.mime_type.` HTTP transport errors retain only their exception type. Raw upstream messages, user descriptions, context, API keys, and JWTs are never logged; unrecognized messages retain only the HTTP status and generic summary. For malformed successful responses, `provider_invalid` logs include a fixed `validationStage` (`response`, `candidate`, `content`, `json`, `envelope`, `analysis`, `usage`, `sse`, or `completion`) and exception type. A token-limit finish instead records `validationStage=candidate` and the allowlisted `finishReason=MAX_TOKENS`; partial output never becomes an expense. These diagnostics do not include model text, field values, or raw exception messages. Diagnostics stay server-side: JSON/SSE browser error payloads remain `{error:{code,uncertain}}`.

## Production migrations

The chain is `20261011000000_existing_public_baseline.sql` → `202610120001_semantic_entry.sql` → `202610130001_semantic_trigger_citext.sql`. The baseline captures existing public schema without application data. Its older version establishes ordering; it was captured on 2026-10-13. On the designated project, baseline and existing semantic migration were recorded as applied after verification; only the trigger fix was executed. Never rerun adopted schema DDL or mark unverified changes applied.

The repository's `supabase/config.toml` remains the disposable test configuration. Production CLI operations use an initialized independent workdir with only the reviewed migration files. Compare `migration list`, review `db push --dry-run`, then apply pending changes with `db push --yes`. Future migrations must follow the adopted chain; do not edit applied files or run a remote reset.

`.github/workflows/supabase-migrations.yml` verifies the full schema chain on PRs. Production execution is manual, master-only, defaults to dry-run, checks the designated project and adopted baseline, and serializes migration jobs. Create the GitHub `supabase-production` environment with:

| Setting                                | Purpose                                                               |
| -------------------------------------- | --------------------------------------------------------------------- |
| Variable `SUPABASE_PROJECT_REF`        | The designated project ref, enforced by the workflow                  |
| Secret `SUPABASE_ACCESS_TOKEN`         | CLI platform authentication; never put this in public frontend config |
| Optional secret `SUPABASE_DB_PASSWORD` | Database connection password if CLI temporary login is unavailable    |

Configure environment reviewers as appropriate. First run with the default `dry_run=true`, review pending changes, then explicitly use `dry_run=false` for an authorized apply. The workflow does not bootstrap migration history, seed app settings, or modify Cloud Run. Hosted workflow execution remains unverified.

For a fresh local chain test without production access:

```sh
services/semantic-entry/scripts/baseline-db-test.sh
```

This uses a disposable PostgreSQL 17 container, synthetic auth helpers and data, and removes its container on exit. It verifies actual public-schema triggers/types plus semantic replay/quota behavior; it does not verify GoTrue or the entire Supabase platform.

## Disposable database tests

The full Supabase CLI path used by Linux CI starts local services with automatic migrations disabled, installs the synthetic expense fixture first, then installs the draft RPC. On a fresh disposable stack:

```sh
supabase start
docker exec -i supabase_db_jopie-semantic-entry-test psql -U postgres -v ON_ERROR_STOP=1 < supabase/fixtures/semantic-entry-test-schema.sql
docker exec -i supabase_db_jopie-semantic-entry-test psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/202610120001_semantic_entry.sql
supabase status -o env > /tmp/jopie-semantic-supabase.env
set -a
. /tmp/jopie-semantic-supabase.env
set +a
TEST_SUPABASE_URL="$API_URL" uv run --directory services/semantic-entry --locked pytest -o addopts="" tests/test_db_integration.py
supabase stop --no-backup
```

Use only the dedicated local test project; the fixture is not safe for an existing database. Do not commit or print the generated credential file. Local service-role test credentials are privileged and never belong in the application runtime. Tests reject non-local URLs before constructing privileged clients.

On the development Mac, CLI 2.120.0 failed in its realtime migration with an OS monotonic-clock error. The locally verified fallback uses dedicated PostgreSQL 17/PostgREST containers with synthetic auth helpers/JWTs; it does not verify GoTrue or full Supabase bootstrap:

```sh
services/semantic-entry/scripts/local-db.sh
docker exec -i jopie-semantic-test-db psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/202610120001_semantic_entry.sql
TEST_SUPABASE_URL=http://127.0.0.1:55421 TEST_STANDALONE_POSTGREST=1 uv run --directory services/semantic-entry --locked pytest -o addopts="" tests/test_db_integration.py
docker rm -f jopie-semantic-test-rest jopie-semantic-test-db
```

These commands initialize a fresh stack; they are not a rerunnable migration procedure. Full Supabase Linux CI remains unverified until its workflow executes.

## GitHub Actions release

FastAPI routing retains the existing `python -m semantic_entry.server` container entrypoint and `PORT` handling. Automatic API documentation endpoints are disabled.

The public health endpoint is `/health`. Avoid `/healthz`: Cloud Run reserves some URL paths ending in `z`, which can return a Google frontend 404 before reaching the container. See [Cloud Run reserved URL paths](https://docs.cloud.google.com/run/docs/known-issues#reserved-url-paths). After pushing the endpoint and workflow changes to `master`, start a new workflow run; rerunning an old run uses its original source revision.

The release target is the existing **Cloud Run container service**, rather than a Functions Framework source entry point. `.github/workflows/semantic-entry-deploy.yml` is manual-only and runs only from `master`. Its separate verification job runs Python pytest/Ruff/mypy checks and a mocked container smoke before the deployment job obtains credentials. CI and local fixture evaluation do not use the model key.

Configure GCP in the console after code review:

1. Select project/region and enable Cloud Run, Artifact Registry, Secret Manager, IAM, IAM Credentials, and Security Token Service APIs. Create a Docker Artifact Registry repository in the chosen region; set a budget/alerts.
2. Create separate deployer and runtime service accounts. Give the deployer Artifact Registry Writer on that repository, Cloud Run Developer for the intended service (project scope is needed for initial creation), and Service Account User only on the runtime account. The deployer does not need to read the model secret or administer the database. Give the runtime Secret Manager Secret Accessor only on the model-key secret. Member display names are ordinary runtime configuration, provided by the GitHub environment variable `SEMANTIC_MEMBER_NAMES`.
3. Create a GitHub OIDC Workload Identity pool/provider. Restrict its attribute condition to your repository/owner IDs and `refs/heads/master`; grant the matching principal Workload Identity User only on the deployer account. Do not upload a service-account JSON key to GitHub. Follow [Google's authentication action setup](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation).
4. Create a Secret Manager version for the Gemini API key. Record numeric versions, not `latest`. Verify the actual expense schema/RLS, install only the reviewed production-compatible migration, and confirm the caller can read existing expense categories before releasing. This workflow never applies SQL.
5. Configure public browser access for the Cloud Run service in the console. Supabase bearer JWT authentication remains enforced inside the application. The deployer does not change IAM/public invocation policy. If the first deployment creates a private service, its unauthenticated health check fails after deployment; configure public invocation and rerun. The failed health step does not roll back the deployed revision. See [public access configuration](https://docs.cloud.google.com/run/docs/authenticating/public) and [required deployment roles](https://docs.cloud.google.com/run/docs/deploying).

Create the GitHub environment `semantic-entry-production`, restrict it to `master`, and configure required reviewers if desired. Add these environment variables:

| Name                             | Value                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GCP_PROJECT_ID`                 | Selected project ID                                                                              |
| `GCP_REGION`                     | Selected region, e.g. `asia-east1`                                                               |
| `GCP_ARTIFACT_REPOSITORY`        | Docker repository name                                                                           |
| `GCP_CLOUD_RUN_SERVICE`          | Dedicated service name, e.g. `jopie-semantic-entry`                                              |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | Deployer service account email                                                                   |
| `GCP_RUNTIME_SERVICE_ACCOUNT`    | Separate runtime service account email                                                           |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>` name |
| `SEMANTIC_GEMINI_SECRET`         | Secret name plus numeric version, e.g. `semantic-gemini-key:1`                                   |
| `SEMANTIC_MODEL`                 | Optional; defaults to `gemini-3.5-flash-lite`                                                    |
| `SEMANTIC_MEMBER_NAMES`          | JSON email-to-display-name mapping, e.g. `{"a@example.test":"甲"}`                               |
| `SEMANTIC_ALLOWED_ORIGINS`       | Exact HTTPS frontend origins, comma-separated without whitespace, path, or trailing slash        |
| `PUBLIC_SUPABASE_URL`            | Existing Supabase project HTTPS origin                                                           |

The workflow validates `SEMANTIC_MEMBER_NAMES` as a JSON object with string values, then injects it into the Cloud Run runtime through `--env-vars-file`; it is not baked into the container image. Updating the GitHub variable takes effect on the next deployment. This mapping is ordinary configuration visible to users with access to those settings; it is not a Secret Manager binding. No `semantic-member-names` secret is required. The mapping does not grant database authorization, which remains controlled by Supabase. Names used in descriptions (for example, 「派大」 in 「與派大平分」) must match this backend mapping or a member email; the frontend `PUBLIC_EMAIL_NAME_MAPPING` is not automatically read by the service. Unmapped members use their email as their name. Use distinct names to avoid ambiguous matches. Bare 「平分」 without specified participants or headcount defaults to all currently allowed members; specified members take precedence. Shares are calculated by the backend, not Gemini.

Add the environment secret `PUBLIC_SUPABASE_PUBLISHABLE_KEY` (publishable key only). The workflow writes a temporary runtime environment file, binds secret references, pushes an image tagged with the source SHA, and deploys the resolved immutable digest. The environment file and secret bindings are authoritative for this dedicated service. It uses request-based CPU allocation, zero minimum/two maximum instances, one vCPU, 512 MiB, and a 30-second request timeout. It does not set up IAM, create secret versions, or run paid evaluation. The workflow definition has been inspected locally; Google authentication, permissions, Artifact Registry push, and hosted behavior require the first authorized execution.

For the conversation date-baseline update, release the backend before rebuilding the frontend. The new backend accepts legacy requests without `referenceDate`, but the previous strict backend rejects the new frontend field. This change needs no SQL migration.

After deployment, set repository variable `PUBLIC_SEMANTIC_ENTRY_URL` to the emitted service origin for both Pages/build workflows. Release/rebuild Pages separately. Cloud Run deployment does not rebuild the frontend. `/health` checks process reachability only; complete the hosted acceptance items above before claiming the expense flow works in production. Use Cloud Run revision traffic controls for an operator-directed rollback.

## Gemini model configuration

`SEMANTIC_MODEL` is read from GitHub repository/environment variables and injected at deployment. Supported identifiers are `gemini-3.5-flash-lite` (default), `gemini-3.6-flash`, `gemini-3.8-flash`, `gemini-2.5-flash`, and `gemini-2.5-flash-lite`. The 3.8 model uses LOW thinking; other supported 3.x models use MINIMAL; 2.5 Flash models use thinkingBudget 0. Older 2.5 availability can be limited to existing users; verify access for the actual key before release. Model access, schema acceptance, latency and extraction quality remain unverified without an authorized live call.

Set `SEMANTIC_GEMINI_SECRET=semantic-gemini-key:1` and create that enabled Secret Manager version with the API key. The workflow binds it to `GEMINI_API_KEY`. `SEMANTIC_OPENAI_SECRET`, `OPENAI_API_KEY`, and `SEMANTIC_MEMBER_NAMES_SECRET` are no longer consumed. Remove old secrets only after checking other services and revisions for references. The adapter uses REST generateContent with `x-goog-api-key`, one candidate, an 800-token generation cap, JSON schema output and no tools or automatic retries. Application tracing remains disabled; this does not make a claim about Gemini provider-side retention.
