#!/usr/bin/env python3
"""Runs the real worker loop (studio_worker.jobs.main) against a real VLM API, with a fake agent CLI and a fake
renderer: what the server's contract test (apps/server/test/studio-contract.test.ts) drives.

    VLM_API_URL=... STUDIO_WORKER_TOKEN=... STUDIO_DESIGN_ID=... STUDIO_IDLE_EXIT_SEC=2 python3 drive_worker.py

The agent replays tests/fakes/claude_builds_hat.jsonl (STUDIO_FAKE_AGENT names another fixture); each render writes 36
small webp frames. The skills' checker runs for real: from /opt/skills, or the checkout STUDIO_SKILLS names.
"""
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
from studio_worker import config, jobs  # noqa: E402

FAKES = HERE / 'tests' / 'fakes'
LOCAL_SKILLS = Path(os.environ.get('STUDIO_SKILLS', Path.home() / '-Decentraland/dcl-avatar-skills'))


def fake_render(pieces, view, out, frames=36, size=512, watchdog_sec=300):
    out.mkdir(parents=True, exist_ok=True)
    paths = []
    for i in range(frames):
        paths.append(out / f'{i:03d}.webp')
        Image.new('RGB', (8, 8), (i * 7, 40, 90)).save(paths[-1], 'WEBP')
    return {'ok': True, 'frames': paths, 'error': None, 'bootSec': 0.1}


def main() -> int:
    if not (config.SKILLS / 'skills').exists():
        config.SKILLS = LOCAL_SKILLS
    fixture = FAKES / os.environ.get('STUDIO_FAKE_AGENT', 'claude_builds_hat.jsonl')
    with tempfile.TemporaryDirectory() as tmp:
        design = Path(tmp) / 'design'
        return jobs.main(design=design, poll_sec=0.2, render_fn=fake_render,
                         command=[sys.executable, str(FAKES / 'replay.py'), str(fixture)], as_user=None)


if __name__ == '__main__':
    sys.exit(main())
