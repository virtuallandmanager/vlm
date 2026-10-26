#!/usr/bin/env bash
# Runs one finalize job on the fixture cap and the wave emote inside the worker image, with the real tools: Blender
# (thumbnail and clipping), Decentraland's wearable-preview (renders and promo), ffmpeg and the skills' checks. No agent
# runs, so it costs nothing. Needs the base avatar .blend files in apps/studio-worker/assets.
#   bash apps/studio-worker/e2e/finalize_real.sh [out dir, default /tmp/studio-finalize-real]
# Prints each result, the package's files and its REPORT.md; the packages land in the out dir.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-/tmp/studio-finalize-real}
mkdir -p "$out"
docker build -q --platform linux/amd64 -t vlm-studio-worker:dev "$here" >/dev/null
docker run -i --rm --platform linux/amd64 --cap-add NET_ADMIN -v "$here/tests:/opt/tests:ro" -v "$out:/out" \
  vlm-studio-worker:dev python3 - <<'PY'
import io, json, sys, tempfile, time, zipfile
from pathlib import Path
sys.path.insert(0, '/opt/tests')
import fake_api
from studio_worker import jobs
from studio_worker.api import Api

FIX = Path('/opt/tests/fixtures')
CAP = {'name': 'Neon Cap', 'description': 'A cap with a glowing visor', 'category': 'hat', 'hides': [], 'replaces': [],
       'tags': ['cyberpunk', 'neon', 'cap'], 'rarity': 'rare', 'changeKind': 'new'}
WAVE = {'name': 'Big Wave', 'description': 'A wave you can see across the plaza', 'category': 'emote', 'tags': ['wave'],
        'loop': False, 'changeKind': 'new'}
CASES = [
    ('hat', 'wearable', CAP, {'pieces/hat/neon_cap_male.glb': FIX / 'cap/neon_cap_male.glb',
                              'pieces/hat/neon_cap_female.glb': FIX / 'cap/neon_cap_female.glb'}),
    ('emote', 'emote', WAVE, {'pieces/emote/wave.glb': FIX / 'wave.glb'}),
]
with fake_api.serve(token='t', design='d') as api:
    client = Api(api.url, 't', 'd', backoff=0.1)
    for category, kind, meta, glbs in CASES:
        job_id = f'job-{category}'
        files = list(glbs) + [f'pieces/{category}/piece.json', f'checks/{category}.txt']
        for path, src in glbs.items():
            api.inputs[f'{job_id}/{path}'] = src.read_bytes()
        api.inputs[f'{job_id}/pieces/{category}/piece.json'] = json.dumps(meta).encode()
        api.inputs[f'{job_id}/checks/{category}.txt'] = b'(the revision\'s checker report)\n'
        job = {'jobId': job_id, 'type': 'finalize', 'kind': kind, 'agent': None, 'model': None, 'prompt': None,
               'selectedSlots': None, 'limits': {'timeoutSec': 1800, 'maxTurns': 0, 'costCeilingUsd': 0}, 'render': None,
               'finalize': {'designName': 'Finalize check', 'pieces': [{'category': category, 'name': meta['name'],
                                                                        'revision': 1, 'files': files}]}}
        start = time.monotonic()
        with tempfile.TemporaryDirectory() as tmp:
            result = jobs.run_job(job, client, Path(tmp) / 'design')
        print(f'== {category}: {result["outcome"]} in {time.monotonic() - start:.0f}s', result['error'] or '')
        print(json.dumps(result['pieces'], indent=1))
        body = api.files.get(f'{job_id}/final/{category}/package.zip')
        if not body:
            continue
        Path(f'/out/{category}-package.zip').write_bytes(body)
        z = zipfile.ZipFile(io.BytesIO(body))
        for info in z.infolist():
            print(f'  {info.file_size:>9}  {info.filename}')
        print(z.read('REPORT.md').decode())
PY
ls -la "$out"
