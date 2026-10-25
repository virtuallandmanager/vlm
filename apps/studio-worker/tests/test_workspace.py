import io
import tarfile

import pytest

from studio_worker.workspace import State, load_state, pack, prompt_with_context, save_state, unpack


def test_pack_unpack_round_trip(tmp_path):
    design = tmp_path / 'design'
    (design / 'out/hat').mkdir(parents=True)
    (design / 'out/hat/cap_male.glb').write_bytes(b'glb')
    (design / '.claude-home/projects').mkdir(parents=True)
    (design / '.claude-home/projects/s.jsonl').write_text('{}')
    (design / '.claude/skills/x').mkdir(parents=True)
    (design / '.claude/skills/x/SKILL.md').write_text('image-owned')
    save_state(design, State(sessions={'claude': 's1'}, last_agent='claude'))
    data = pack(design)
    restored = tmp_path / 'restored'
    unpack(data, restored)
    assert (restored / 'out/hat/cap_male.glb').read_bytes() == b'glb'
    assert (restored / '.claude-home/projects/s.jsonl').read_text() == '{}'
    assert load_state(restored).sessions == {'claude': 's1'}
    assert not (restored / '.claude/skills').exists()  # the image's skills are never saved with a design


def test_unpack_rejects_path_escape(tmp_path):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w:gz') as tar:
        info = tarfile.TarInfo('../evil')
        info.size = 4
        tar.addfile(info, io.BytesIO(b'evil'))
    with pytest.raises(ValueError):
        unpack(buf.getvalue(), tmp_path / 'design')
    assert not (tmp_path / 'evil').exists()


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
