#!/usr/bin/env bash
# The worker image's entrypoint. Runs the given command, or the worker.
set -euo pipefail
if [ $# -gt 0 ]; then exec "$@"; fi
exec python3 -m studio_worker
