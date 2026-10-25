from pathlib import Path

import preview_probe
from preview_probe import is_blank

FIX = Path(__file__).parent / 'fixtures'


def test_blank_frame_detected():
    assert is_blank(str(FIX / 'blank.png'))


def test_real_frame_not_blank():
    assert not is_blank(str(FIX / 'avatar.png'))


def test_all_blank_is_not_ok(tmp_path):
    fake = tmp_path / 'fake_preview.sh'  # stands in for preview_wearable.py: writes blank frames, prints each path
    fake.write_text('#!/bin/sh\nfor i in 0 1 2; do cp ' + str(FIX / 'blank.png') + ' "$OUT_$i.png"; echo "$OUT_$i.png"; done\n'
                    .replace('$OUT', str(tmp_path / 'f')))
    fake.chmod(0o755)
    r = preview_probe.probe(mode='webgpu', angle='swiftshader', category='hat', male=None, female=None,
                            out=tmp_path / 'p', frames=3, command=[str(fake)])
    assert (r['ok'], r['framesWritten'], r['blankFrames']) == (False, 3, 3)
    assert (tmp_path / 'p' / 'probe.json').exists()


def test_frames_are_timed_when_saved(tmp_path):
    # Like the real preview: it saves each frame as it goes but prints the paths only when its browser closes
    fake = tmp_path / 'fake_preview.py'
    fake.write_text('import shutil, time\nps = []\nfor i in range(3):\n    time.sleep(0.5)\n'
                    f'    p = "{tmp_path}/f_%d.png" % i\n    shutil.copy("{FIX / "avatar.png"}", p)\n    ps.append(p)\n'
                    'time.sleep(0.5)\nprint("\\n".join(ps))\n')
    r = preview_probe.probe(mode='babylon', angle='swiftshader', category='hat', male=None, female=None,
                            out=tmp_path / 'p', frames=3, command=['python3', str(fake)])
    assert r['ok']
    assert r['bootSec'] < 1.4
    assert 0.4 < r['secPerFrame'] < 1.0
