// Service deadlines in services/semantic-entry/semantic_entry/graph.py:44 and :47.
// Keep these constants in sync when changing the service deadlines.
export const SERVICE_TEXT_DEADLINE_MS = 30_000;
export const SERVICE_IMAGE_DEADLINE_MS = 85_000;
// .github/workflows/semantic-entry-deploy.yml:138 deploys with --timeout=90s.
export const CLOUD_RUN_TIMEOUT_MS = 90_000;
// Client = min(service deadline + 15 seconds, Cloud Run timeout + 5 seconds).
export const SEMANTIC_TIMEOUT_MS = 45_000;
export const SEMANTIC_IMAGE_TIMEOUT_MS = 95_000;
