#!/usr/bin/env bash
# Renders the fixture cap's spin and the spike's wave emote in the real wearable-preview, inside the worker image.
#   bash apps/studio-worker/e2e/render_real.sh [out dir, default /tmp/studio-render-real]
# Prints each render's result and whether frames 0 and 9 differ; the frames land in the out dir to look at.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-/tmp/studio-render-real}
mkdir -p "$out"
docker build -q --platform linux/amd64 -t vlm-studio-worker:dev "$here" >/dev/null
docker run -i --rm --platform linux/amd64 -v "$here/tests/fixtures:/fixtures:ro" -v "$out:/out" \
  vlm-studio-worker:dev python3 - <<'PY'
import json
from pathlib import Path
import numpy as np
from PIL import Image
from studio_worker.render import render

cap = {'category': 'hat', 'glbs': {'male': Path('/fixtures/cap/neon_cap_male.glb'),
       'female': Path('/fixtures/cap/neon_cap_female.glb')}, 'meta': {'name': 'Neon Cap'}}
wave = {'category': 'emote', 'glbs': {'unisex': Path('/fixtures/wave.glb')}, 'meta': {'name': 'Wave', 'loop': False}}
for name, pieces, mode in (('spin', [cap], 'spin'), ('emote', [wave], 'emote')):
    r = render(pieces, {'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': mode}, Path('/out') / name)
    differ = None
    if r['ok']:
        a, b = (np.asarray(Image.open(r['frames'][i]).convert('RGB'), dtype=np.int16) for i in (0, 9))
        differ = float(np.abs(a - b).mean())
    print(name, json.dumps({'ok': r['ok'], 'frames': len(r['frames']), 'error': r['error'], 'bootSec': r['bootSec'],
                            'frame0vs9MeanDiff': differ}))
PY
