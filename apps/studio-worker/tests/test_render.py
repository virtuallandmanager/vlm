import json
import shutil
import threading
import time
from functools import partial
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import FIXTURES
from studio_worker import config, render

HAT = {'category': 'hat', 'glbs': {'male': FIXTURES / 'cap/neon_cap_male.glb',
                                   'female': FIXTURES / 'cap/neon_cap_female.glb'}, 'meta': {'name': 'Neon Cap'}}
WAVE = {'category': 'emote', 'glbs': {'unisex': FIXTURES / 'wave.glb'}, 'meta': {'name': 'Wave', 'loop': False}}
SPIN = {'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'spin'}

pytestmark = pytest.mark.skipif(not (shutil.which('google-chrome') or render.chrome_available()),
                                reason='needs Google Chrome')


@pytest.fixture
def stub(monkeypatch):
    """Serves the stub preview and records the controller requests it is sent."""
    calls = []

    class Handler(SimpleHTTPRequestHandler):
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(FIXTURES)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/preview_stub.html'

    def use(mode=''):
        monkeypatch.setattr(config, 'PREVIEW_URL', base + (f'?stub={mode}' if mode else ''))
        return calls

    yield use
    server.shutdown()


def test_render_watchdog_kills_hung_preview(tmp_path, stub):
    stub('hang')
    start = time.monotonic()
    r = render.render([HAT], SPIN, tmp_path, watchdog_sec=3)
    assert r['ok'] is False and r['error'] == 'timeout'
    assert time.monotonic() - start < 10


def test_item_not_loaded_is_reported(tmp_path, stub):
    stub('noload')
    r = render.render([HAT], SPIN, tmp_path, watchdog_sec=60)
    assert r['ok'] is False and r['error'] == 'item_not_loaded'
    assert not list(tmp_path.glob('*.webp'))  # no frames of a bare avatar


def test_piece_that_lowers_the_triangles_counts_as_loaded(tmp_path, stub):
    stub('fewer')  # a hat that hides the hair, or a jacket replacing the base top
    r = render.render([{**HAT, 'meta': {'name': 'Neon Cap', 'hides': ['hair']}}], SPIN, tmp_path, frames=4,
                      watchdog_sec=60)
    assert r['ok'] is True, r


def test_spin_sends_36_rotations(tmp_path, stub):
    calls = stub()
    r = render.render([HAT], SPIN, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r
    turns = [c for c in calls if c['method'] == 'changeCameraPosition']
    assert len(turns) == 36
    assert all(c['params'][0]['alpha'] == pytest.approx(0.1745, abs=1e-4) for c in turns)
    assert len(r['frames']) == 36 and all(f.suffix == '.webp' and f.exists() for f in r['frames'])


def test_emote_frames_step_through_length(tmp_path, stub):
    calls = stub()
    r = render.render([WAVE], {**SPIN, 'mode': 'emote'}, tmp_path, frames=10, watchdog_sec=60)
    assert r['ok'] is True, r
    names = [c['method'] for c in calls if c['namespace'] == 'emote']
    i = names.index('pause')  # getLength is also read earlier, to see that the emote loaded
    assert names[i + 1] == 'getLength'
    goes = [c['params'][0] for c in calls if c['method'] == 'goTo']
    assert goes == pytest.approx([i * 0.3 for i in range(10)])
    assert len(r['frames']) == 10


def test_studio_preview_takes_relative_paths(tmp_path, stub, monkeypatch):
    stub()
    hat = tmp_path / 'out/hat'
    hat.mkdir(parents=True)
    for g in (FIXTURES / 'cap').glob('*.glb'):
        shutil.copy(g, hat / g.name)
    (hat / 'piece.json').write_text('{"name": "Neon Cap", "category": "hat"}')
    monkeypatch.chdir(tmp_path)
    paths = render.look([Path('out/hat')], Path('review'))
    assert sorted(p.name for p in paths) == sorted(f'{s}-{v}.png' for s in ('male', 'female')
                                                   for v in ('front', 'right', 'back', 'left'))
    assert all((tmp_path / p).exists() for p in paths)


def test_thumbnail_mode_query():
    assert 'disableBackground=true' in render._query({'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'thumbnail'})
    assert 'disableBackground=false' in render._query(SPIN)


def test_emote_thumbnail_is_mid_emote_and_square(tmp_path, stub):
    from PIL import Image
    calls = stub()
    r = render.render([WAVE], {**SPIN, 'mode': 'thumbnail'}, tmp_path, size=512, watchdog_sec=60)
    assert r['ok'] is True, r
    assert [c['params'][0] for c in calls if c['method'] == 'goTo'] == pytest.approx([1.5])
    assert [f.name for f in r['frames']] == ['thumbnail.png']
    image = Image.open(r['frames'][0])
    assert image.size == (256, 256) and image.mode == 'RGBA'
