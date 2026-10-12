# Semantic entry service deployment

The service is implemented locally; hosted deployment is not verified. The SQL in `supabase/migrations/202610120001_semantic_entry.sql` is a **draft tested against a synthetic frontend-contract fixture**, not a migration confirmed compatible with the deployed database. Review the current schema, policies, triggers, grants, defaults, and category IDs before applying it. Do not apply `supabase/fixtures/` to production.

## Local container

Use Node.js 22.12 or later within Node 22:

```sh
npm ci
npm --prefix services/semantic-entry ci
npm --prefix services/semantic-entry test
npm --prefix services/semantic-entry run check
npm --prefix services/semantic-entry run build
docker build -f services/semantic-entry/Dockerfile -t jopie-semantic-entry .
services/semantic-entry/scripts/container-smoke.sh
```

The smoke test injects synthetic dependencies into the real HTTP server and graph. It verifies HTTP/container wiring without a paid model call or live database access. `/healthz` never calls the model. The image runs as `node`, listens on `0.0.0.0:$PORT` (default 8080), and copies only allowlisted source/dependency files. Root `.env` files and test fixtures are excluded.

## Configuration

| Variable                     | Value                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `SUPABASE_URL`               | Existing Supabase project HTTPS origin                                       |
| `SUPABASE_PUBLISHABLE_KEY`   | Publishable key; never a service-role key                                    |
| `OPENAI_API_KEY`             | Secret Manager secret exposed only to the backend                            |
| `SEMANTIC_MODEL`             | `gpt-5.4-mini` by default                                                    |
| `SEMANTIC_MEMBER_NAMES`      | JSON object of allowed email to display name; e.g. `{"a@example.test":"甲"}` |
| `SEMANTIC_OTHER_CATEGORY_ID` | Existing expense category UUID for 其他                                      |
| `SEMANTIC_ALLOWED_ORIGINS`   | Comma-separated exact frontend origins, without paths/trailing slash         |
| `PUBLIC_SEMANTIC_ENTRY_URL`  | Frontend build value: Cloud Run origin; client appends `/semantic-entry`     |

The runtime validates Supabase JWTs through `auth.getUser`, checks the settings allowlist, and sends the same caller JWT to HTTPS Data API/RPC. Cloud Run does not need a PostgreSQL password, direct DB connection, connection pool, or service-role credential. Public Cloud Run ingress and CORS are not authorization. Disable external LangSmith tracing; the server forcibly disables tracing environment flags and emits only sanitized events.

## Hosted setup (operator action, not performed)

Confirm project, region, budget, IAM permissions, Secret Manager access, actual schema/RLS compatibility, and fallback category before deployment. Build/push the image to the chosen Artifact Registry repository. Deploy with request-based CPU billing, minimum zero instances, maximum two, one vCPU, 512 MiB memory, and a 30-second request timeout. Limit the runtime service account's secret access to the required secret only; do not grant project-wide secret access or database administration. Configure secrets with Secret Manager bindings, not plaintext committed environment files. Pin versions when releasing.

Set the frontend's public URL to the service origin, rebuild under the GitHub Pages base path, and configure the frontend origin in CORS. The service accepts `POST /semantic-entry`, `GET /semantic-entry/:requestId`, `OPTIONS`, and `GET /healthz`. It uses one structured model call, an 800-token output cap, reasoning effort `none`, a 15-second model deadline, and no model retries. [Structured output reference](https://developers.openai.com/api/docs/guides/structured-outputs) and [model reference](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

Hosted acceptance still requires a verified-user smoke test, rejected-input zero-write checks, same-request concurrency, a lost-response retry, edited/deleted expense replay, cross-account isolation, real Taiwan-day quota behavior, subpath navigation/session propagation, observed logs without private data, cold start/deadline behavior, and budget/usage monitoring. Local mocks and container success do not establish these results. Paid live evaluation requires separate authorization and must never persist expenses.
