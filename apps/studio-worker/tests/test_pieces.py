import hashlib
import json
import shutil

from conftest import FIXTURES
from studio_worker.instructions import closing
from studio_worker.pieces import check, collect, glbs_by_shape, new_hashes

HAT = {'name': 'Neon Cap', 'description': 'A cap with a glowing visor', 'category': 'hat', 'hides': [],
       'replaces': [], 'tags': ['cyberpunk'], 'changeKind': 'new'}


def lay_out(design, category, glbs, meta):
    d = design / 'out' / category
    d.mkdir(parents=True)
    for g in glbs:
        shutil.copy(g, d / g.name)
    (d / 'piece.json').write_text(json.dumps(meta))
    return d


def cap(design):
    return lay_out(design, 'hat', sorted((FIXTURES / 'cap').glob('*.glb')), HAT)


def test_collects_pieces_and_runs_checker(tmp_path, skills):
    cap(tmp_path)
    pieces, proposal, error = collect(tmp_path, 'wearable', {})
    assert error is None and proposal is None
    assert [p.category for p in pieces] == ['hat']
    assert pieces[0].changed is True and pieces[0].meta['name'] == 'Neon Cap'
    assert pieces[0].checker['ran'] is True and pieces[0].checker['pass'] is True
    assert set(glbs_by_shape(pieces[0])) == {'male', 'female'}


def test_unchanged_piece_not_reported_changed(tmp_path, skills):
    d = cap(tmp_path)
    hashes = {'hat': {g.name: hashlib.sha256(g.read_bytes()).hexdigest() for g in d.glob('*.glb')}}
    pieces, _, error = collect(tmp_path, 'wearable', hashes)
    assert error is None and pieces[0].changed is False
    assert new_hashes(pieces) == hashes


def test_glb_outside_pieces_is_an_error(tmp_path):
    (tmp_path / 'out').mkdir()
    shutil.copy(FIXTURES / 'cap/neon_cap_male.glb', tmp_path / 'out/cap.glb')
    pieces, proposal, error = collect(tmp_path, 'wearable', {})
    assert pieces == [] and proposal is None
    assert 'out/cap.glb' in error


def test_proposal_is_read(tmp_path):
    (tmp_path / 'out').mkdir()
    slots = {'slots': [{'category': 'hat', 'recommended': True, 'reason': 'the visor is the idea'},
                       {'category': 'eyewear', 'recommended': False, 'reason': 'goggles would match'}]}
    (tmp_path / 'out/proposal.json').write_text(json.dumps(slots))
    pieces, proposal, error = collect(tmp_path, 'wearable', {})
    assert proposal == slots and pieces == [] and error is None


def test_checker_fail_is_recorded(tmp_path, skills):
    # 1346 triangles: fine for the jacket it is, over an earring's 500
    lay_out(tmp_path, 'earring', [FIXTURES / 'jacket.glb'], {**HAT, 'category': 'earring'})
    pieces, _, error = collect(tmp_path, 'wearable', {})
    assert error is None
    assert pieces[0].checker['pass'] is False and pieces[0].checker['failures'] >= 1


def test_emote_checker_runs(tmp_path, skills):
    lay_out(tmp_path, 'emote', [FIXTURES / 'wave.glb'], {**HAT, 'category': 'emote', 'loop': False})
    pieces, _, error = collect(tmp_path, 'emote', {})
    assert error is None and pieces[0].checker['pass'] is True
    assert glbs_by_shape(pieces[0]) == {'unisex': tmp_path / 'out/emote/wave.glb'}


def test_closing_names_the_slots_and_forbids_renders():
    text = closing('wearable', ['hat', 'eyewear'])
    for words in ('hat', 'eyewear', 'studio-preview', 'never render', '/opt/assets', 'piece.json'):
        assert words in text
    assert 'proposal.json' in closing('wearable', None)
