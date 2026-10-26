#!/usr/bin/env bash
# Builds VLM's Hyperfy world image for Fly (linux/amd64) and pushes registry.fly.io/vlm-hyperfy-image:<git short sha>.
# Needs `fly auth docker` (or `flyctl auth docker`) done first. Prints the pushed tag, the value for HYPERFY_IMAGE.
set -euo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root"
if [ -n "$(git status --porcelain -- infra/hyperfy packages/hyperfy-app/dist)" ]; then
  echo "infra/hyperfy or the built VLM app has uncommitted changes; commit them so the tag matches the image" >&2
  exit 1
fi
tag="registry.fly.io/vlm-hyperfy-image:$(git rev-parse --short HEAD)"
docker build --platform linux/amd64 -f infra/hyperfy/Dockerfile -t "$tag" .
docker push "$tag"
echo "$tag"
