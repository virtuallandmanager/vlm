#!/usr/bin/env bash
# Checks the worker image's network lockdown: run as the entrypoint runs on a machine, with NET_ADMIN.
#   bash apps/studio-worker/e2e/network.sh
# Then shows the hosts the proxy denied, so the allowlist can be completed.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
docker build -q --platform linux/amd64 -t vlm-studio-worker:dev "$here" >/dev/null
# The keys file (gitignored) defaults to this checkout's; STUDIO_ENV_FILE points at another one
env_file=${STUDIO_ENV_FILE:-$here/.env}
docker run -i --rm --platform linux/amd64 --cap-add NET_ADMIN --env-file "$env_file" -v "$here/tests/fixtures:/fixtures:ro" \
  --entrypoint /opt/entrypoint.sh vlm-studio-worker:dev bash -s < "$here/e2e/network_checks.sh"
