import io
import json
import os
import tarfile

import pytest

from studio_worker.workspace import State, load_state, pack, prompt_with_context, save_state, unpack


def dirs(tmp_path):
    return tmp_path / 'design', tmp_path / 'state'


def test_pack_unpack_round_trip(tmp_path):
    design, state = dirs(tmp_path)
    (design / 'out/hat').mkdir(parents=True)
    (design / 'out/hat/cap_male.glb').write_bytes(b'glb')
    (design / '.claude-home/projects').mkdir(parents=True)
    (design / '.claude-home/projects/s.jsonl').write_text('{}')
    (design / '.claude/skills/x').mkdir(parents=True)
    (design / '.claude/skills/x/SKILL.md').write_text('image-owned')
    save_state(state, State(sessions={'claude': 's1'}, last_agent='claude'))
    data = pack(design, state)
    restored, restored_state = tmp_path / 'r/design', tmp_path / 'r/state'
    unpack(data, restored, restored_state)
    assert (restored / 'out/hat/cap_male.glb').read_bytes() == b'glb'
    assert (restored / '.claude-home/projects/s.jsonl').read_text() == '{}'
    assert load_state(restored_state).sessions == {'claude': 's1'}
    assert not (restored / '.claude/skills').exists()  # the image's skills are never saved with a design


def test_state_is_kept_outside_the_design(tmp_path):
    design, state = dirs(tmp_path)
    (design / '.studio').mkdir(parents=True)
    (design / '.studio/state.json').write_text(json.dumps({'totals': {'claude': {'cost_usd': 1000}}}))
    save_state(state, State(last_agent='codex'))
    restored, restored_state = tmp_path / 'r/design', tmp_path / 'r/state'
    unpack(pack(design, state), restored, restored_state)
    assert load_state(restored_state) == State(last_agent='codex')  # the agent's planted file is just a file


def test_pack_leaves_out_symlinks(tmp_path):
    design, state = dirs(tmp_path)
    (design / '.venv/bin').mkdir(parents=True)
    os.symlink('/usr/bin/python3', design / '.venv/bin/python')
    os.symlink('/etc/hosts', design / 'hosts.glb')
    (design / 'build.py').write_text('print(1)')
    save_state(state, State())
    restored, restored_state = tmp_path / 'r/design', tmp_path / 'r/state'
    unpack(pack(design, state), restored, restored_state)  # an ordinary venv never breaks the workspace
    assert (restored / 'build.py').read_text() == 'print(1)'
    assert not os.path.lexists(restored / '.venv/bin/python') and not os.path.lexists(restored / 'hosts.glb')


def tar_with(*members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        for info, data in members:
            tar.addfile(info, io.BytesIO(data) if data else None)
    return buf.getvalue()


def test_unpack_rejects_path_escape(tmp_path):
    info = tarfile.TarInfo('design/../../evil')
    info.size = 4
    with pytest.raises(ValueError):
        unpack(tar_with((info, b'evil')), *dirs(tmp_path))
    assert not (tmp_path / 'evil').exists()


def test_unpack_rejects_links(tmp_path):
    a = tarfile.TarInfo('design/a')
    a.type, a.linkname = tarfile.SYMTYPE, '.'
    b = tarfile.TarInfo('design/b')
    b.type, b.linkname = tarfile.SYMTYPE, 'a/..'
    f = tarfile.TarInfo('design/b/escaped.txt')
    f.size = 1
    with pytest.raises(ValueError):
        unpack(tar_with((a, None), (b, None), (f, b'x')), *dirs(tmp_path))
    assert not (tmp_path / 'escaped.txt').exists()


def test_switching_agent_carries_the_conversation():
    state = State(messages=[{'role': 'user', 'agent': 'claude', 'text': 'a neon cap'},
                            {'role': 'agent', 'agent': 'claude', 'text': 'Built a neon cap with a visor.'}],
                  last_agent='claude')
    p = prompt_with_context(state, 'codex', 'make the visor pink')
    assert p.startswith('Conversation so far:')
    assert 'a neon cap' in p and 'Built a neon cap with a visor.' in p
    assert p.rstrip().endswith('make the visor pink')
    assert prompt_with_context(state, 'claude', 'make the visor pink') == 'make the visor pink'


def test_state_survives_missing_file(tmp_path):
    assert load_state(tmp_path) == State()
