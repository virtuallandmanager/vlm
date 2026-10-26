#!/usr/bin/env python3
"""Runs the real worker loop (studio_worker.jobs.main) against a real Virvi API, with a fake agent CLI and a fake
renderer: what the server's contract test (apps/server/test/studio-contract.test.ts) drives.

    VIRVI_API_URL=... STUDIO_WORKER_TOKEN=... STUDIO_DESIGN_ID=... STUDIO_IDLE_EXIT_SEC=2 python3 drive_worker.py

The agent replays tests/fakes/claude_builds_hat.jsonl (STUDIO_FAKE_AGENT names another fixture); each render writes
small frames. The skills' checker runs for real: from /opt/skills, or the checkout STUDIO_SKILLS names. With
STUDIO_FAKE_TOOLS=1, a finalize job's Blender and ffmpeg are fakes that write small valid files (the thumbnail is a
256 px transparent PNG), while the skills' Python checks and package_item.py run for real.
"""
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
from studio_worker import config, jobs  # noqa: E402
from studio_worker.finalize import Tools  # noqa: E402

FAKES = HERE / 'tests' / 'fakes'
LOCAL_SKILLS = Path(os.environ.get('STUDIO_SKILLS', Path.home() / '-Decentraland/dcl-avatar-skills'))


def fake_render(pieces, view, out, frames=36, size=512, watchdog_sec=300):
    out.mkdir(parents=True, exist_ok=True)
    if view.get('mode') == 'look':
        paths = [out / f"{view['bodyShape']}-{v}.png" for v in ('front', 'right', 'back', 'left')]
        for p in paths:
            Image.new('RGB', (16, 16), (90, 40, 40)).save(p)
        return {'ok': True, 'frames': paths, 'error': None, 'bootSec': 0.1}
    if view.get('mode') == 'thumbnail':
        paths = [out / 'thumbnail.png']
        Image.new('RGBA', (256, 256), (0, 0, 0, 0)).save(paths[0])
        return {'ok': True, 'frames': paths, 'error': None, 'bootSec': 0.1}
    paths = []
    for i in range(frames):
        paths.append(out / f'{i:03d}.webp')
        Image.new('RGB', (8, 8), (i * 7, 40, 90)).save(paths[-1], 'WEBP')
    return {'ok': True, 'frames': paths, 'error': None, 'bootSec': 0.1}


def fake_tools() -> Tools:
    real = Tools.real()

    def blender(args, timeout):
        args = [str(a) for a in args]
        if any(a.endswith('thumbnail_blend.py') for a in args):
            image = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
            image.paste((200, 30, 120, 255), (64, 64, 192, 192))  # the item, alone on a transparent background
            image.save(args[args.index('--out') + 1])
            return True, 'fake thumbnail'
        if any(a.endswith('check_clipping.py') for a in args):
            Path(args[args.index('--json') + 1]).write_text('{"clips": {"Idle": {"status": "PASS"}}}')
            return True, 'CLIP GATE PASS (fake)'
        return False, 'unexpected blender call'

    def ffmpeg(args, timeout):
        Path(str(args[-1])).write_bytes(b'fake mp4')
        return True, ''

    return Tools(blender=blender, python=real.python, ffmpeg=ffmpeg)


def main() -> int:
    if not (config.SKILLS / 'skills').exists():
        config.SKILLS = LOCAL_SKILLS
    fixture = FAKES / os.environ.get('STUDIO_FAKE_AGENT', 'claude_builds_hat.jsonl')
    with tempfile.TemporaryDirectory() as tmp:
        design = Path(tmp) / 'design'
        extra = {'tools': fake_tools()} if os.environ.get('STUDIO_FAKE_TOOLS') == '1' else {}
        return jobs.main(design=design, poll_sec=0.2, render_fn=fake_render,
                         command=[sys.executable, str(FAKES / 'replay.py'), str(fixture)], as_user=None, **extra)


if __name__ == '__main__':
    sys.exit(main())
