#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
trap 'docker rm -f jopie-semantic-entry-smoke >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name jopie-semantic-entry-smoke -p 127.0.0.1:55808:8080 -v "$PWD/services/semantic-entry/scripts/smoke-server.py:/tmp/smoke-server.py:ro" jopie-semantic-entry python /tmp/smoke-server.py >/dev/null
python3 services/semantic-entry/scripts/smoke-client.py
