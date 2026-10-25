#!/usr/bin/env python3
"""Can Decentraland's wearable-preview render headless on this machine, and how fast?

    python3 preview_probe.py --mode webgpu|babylon --angle vulkan|swiftshader --category hat \
        --male m.glb --female f.glb --out <dir> [--frames 36] [--emote e.glb]

Runs the skills' preview_wearable.py (a patched copy: its Chrome flags say --use-angle=metal, macOS only) and writes
<dir>/probe.json: whether it worked, how many frames came out blank, the boot time and the time per frame.
"""
import argparse
import json
import os
import subprocess
import time
from pathlib import Path

import numpy as np
from PIL import Image

PREVIEW = Path('/opt/skills/skills/curating-dcl-wearables/scripts/preview_wearable.py')
NEW_BROWSER_SEC = 10  # a gap this long between two frames is the next browser booting, not a frame

# An emote travels as an emoteDataADR74 definition in place of a wearable's data (wearable-preview src/lib/emote.ts)
EMOTE_JS = """  if (item.category === 'emote') {
    def.emoteDataADR74 = {category: 'dance', tags: [], loop: true, representations: reps};
    delete def.data;
  }
  window.postMessage("""


def is_blank(png_path: str, threshold: float = 4.0) -> bool:
    """True when the frame is one flat colour: the renderer drew nothing."""
    pixels = np.asarray(Image.open(png_path).convert('RGB'), dtype=np.float32).reshape(-1, 3)
    return float(pixels.std(axis=0).max()) < threshold  # per channel: one flat colour differs between channels


def preview_command(mode: str, angle: str, category: str, male, female, prefix: Path, frames: int,
                    emote=None) -> list[str]:
    src = PREVIEW.read_text().replace('--use-angle=metal', f'--use-angle={angle}')
    if emote:
        src = src.replace('  window.postMessage(', EMOTE_JS, 1)
    script = prefix.parent / 'preview.py'
    script.write_text(src)
    cmd = ['python3', str(script), '--out', str(prefix), '--frames', str(frames), '--anims', 'idle']
    cmd += ['--category', 'emote', '--unisex', str(emote)] if emote else ['--category', category]
    cmd += ['--male', str(male)] if male and not emote else []
    cmd += ['--female', str(female)] if female and not emote else []
    return cmd + (['--babylon'] if mode == 'babylon' else [])


def probe(mode: str, angle: str, category: str, male, female, out: Path, frames: int = 36, emote=None,
          command: list[str] | None = None, timeout: int = 900) -> dict:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    cmd = command or preview_command(mode, angle, category, male, female, out / 'frame', frames, emote)
    result = {'mode': mode, 'angle': angle, 'emote': bool(emote), 'ok': False, 'framesWritten': 0, 'blankFrames': 0,
              'bootSec': None, 'secPerFrame': None, 'error': None}
    start, wall, pngs = time.monotonic(), time.time(), []
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             env=dict(os.environ, PYTHONUNBUFFERED='1'))
        for line in p.stdout:  # the preview prints each frame's path as it saves it
            line = line.strip()
            if line.endswith('.png') and Path(line).exists():
                pngs.append(line)
            elif line:
                result['error'] = ((result['error'] or '') + line + '\n')[-2000:]
            if time.monotonic() - start > timeout:
                p.kill()
                result['error'] = f'timed out after {timeout}s'
        p.wait()
    except OSError as e:
        result['error'] = str(e)
    # timed by when each frame was saved: the preview prints its paths only when its browser closes
    stamps = sorted(os.path.getmtime(f) - wall for f in pngs)
    gaps = [b - a for a, b in zip(stamps, stamps[1:]) if b - a < NEW_BROWSER_SEC]
    blank = sum(is_blank(f) for f in pngs)
    result.update(framesWritten=len(pngs), blankFrames=blank, bootSec=round(stamps[0], 1) if stamps else None,
                  secPerFrame=round(sum(gaps) / len(gaps), 3) if gaps else None,
                  ok=bool(pngs) and blank == 0)
    (out / 'probe.json').write_text(json.dumps(result, indent=2))
    return result


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', required=True, choices=['webgpu', 'babylon'])
    ap.add_argument('--angle', required=True, choices=['vulkan', 'swiftshader'])
    ap.add_argument('--category', default='hat')
    ap.add_argument('--male')
    ap.add_argument('--female')
    ap.add_argument('--emote', help='an emote GLB, played on both shapes in place of a wearable')
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--frames', type=int, default=36)
    a = ap.parse_args()
    r = probe(a.mode, a.angle, a.category, a.male, a.female, a.out, a.frames, a.emote)
    print(json.dumps({k: r[k] for k in ('ok', 'framesWritten', 'blankFrames', 'bootSec', 'secPerFrame')}))
