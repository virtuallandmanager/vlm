#!/usr/bin/env bash
# Builds the generic Virvi runtime and copies bin/index.js into the server's committed runtime dir.
# Usage: VERSION=2 bash dcl-runtime/build.sh   (VERSION defaults to DCL_RUNTIME_VERSION in runtime.ts)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-$(sed -n 's/^export const DCL_RUNTIME_VERSION = \([0-9]*\).*/\1/p' "$ROOT/apps/server/src/services/dcl/runtime.ts")}"
[ -n "$VERSION" ] || { echo "could not determine VERSION" >&2; exit 1; }

cd "$ROOT"
pnpm --filter 'vlm-dcl^...' build   # vlm-dcl's own dependencies, which bundle needs built
pnpm --filter vlm-dcl bundle
cd dcl-runtime
npm install
npx sdk-commands build --production   # minified, no inline sourcemap (~1 MB instead of ~9 MB)
mkdir -p "$ROOT/apps/server/dcl-runtime/$VERSION/bin"
cp bin/index.js "$ROOT/apps/server/dcl-runtime/$VERSION/bin/index.js"
echo "Runtime v$VERSION: $(wc -c < "$ROOT/apps/server/dcl-runtime/$VERSION/bin/index.js") bytes"
