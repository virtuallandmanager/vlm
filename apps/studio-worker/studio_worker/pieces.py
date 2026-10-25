"""Reads what the agent wrote: one piece per category under out/<category>/, or a slot proposal, and runs the skills'
checker on each piece."""
import hashlib
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import config


@dataclass
class Piece:
    category: str
    glbs: list[Path]
    meta: dict  # piece.json
    changed: bool
    checker: dict  # ran, pass, failures, warnings, report


def collect(design: Path, kind: str, hashes: dict, run_checker: bool = True
            ) -> tuple[list[Piece], dict | None, str | None]:
    """The pieces under out/, the slot proposal in out/proposal.json, and an error when the layout is wrong.

    A GLB anywhere but out/<category>/ beside a piece.json is an error: the design is not reported ready with
    pieces missing."""
    out = Path(design) / 'out'
    proposal = _read_json(out / 'proposal.json')
    pieces, problems = [], []
    for d in sorted(p for p in out.iterdir() if p.is_dir()) if out.is_dir() else []:
        meta, glbs = _read_json(d / 'piece.json'), sorted(d.glob('*.glb'))
        if meta is None:
            continue  # its GLBs are reported as strays below
        if not glbs:
            problems.append(f'out/{d.name}/ has a piece.json but no GLB')
        elif kind == 'emote' and d.name != 'emote':
            problems.append(f'an emote goes in out/emote/, not out/{d.name}/')
        elif meta.get('category', d.name) != d.name:
            problems.append(f"out/{d.name}/piece.json says category {meta.get('category')!r}")
        else:
            pieces.append(Piece(category=d.name, glbs=glbs, meta=meta, changed=_shas(glbs) != set((hashes.get(d.name) or {}).values()),
                                checker={'ran': False}))
    placed = {g for p in pieces for g in p.glbs}
    strays = [g for g in sorted(out.rglob('*.glb')) if g not in placed] if out.is_dir() else []
    if strays:
        names = ', '.join(g.relative_to(design).as_posix() for g in strays)
        problems.append(f'GLBs outside out/<category>/ with a piece.json: {names}')
    if problems:
        return [], proposal, '; '.join(problems)
    for p in pieces if run_checker else []:
        p.checker = check(p, kind)
    return pieces, proposal, None


def check(piece: Piece, kind: str) -> dict:
    scripts = config.SKILLS / 'skills'
    if kind == 'emote':
        cmd = ['python3', str(scripts / 'creating-dcl-emotes/scripts/check_emote.py'), *map(str, piece.glbs)]
        cmd += ['--loop'] if piece.meta.get('loop') in (True, 'yes') else []
    else:
        cmd = ['python3', str(scripts / 'creating-dcl-wearables/scripts/check_wearable.py'), *map(str, piece.glbs),
               '--category', piece.category]
        hides = piece.meta.get('hides') or []
        cmd += ['--hides', ','.join(hides) if isinstance(hides, list) else str(hides)] if hides else []
    p = subprocess.run(cmd, capture_output=True, text=True)
    levels = [l.split()[0] for l in p.stdout.splitlines() if l.startswith('  ') and l.split()]
    return {'ran': True, 'pass': p.returncode == 0, 'warnings': levels.count('WARN'), 'failures': levels.count('FAIL'),
            'report': p.stdout + p.stderr}


def new_hashes(pieces: list[Piece]) -> dict:
    return {p.category: {g.name: _sha(g) for g in p.glbs} for p in pieces}


def glbs_by_shape(piece: Piece) -> dict:
    """{'male': path, 'female': path} from the _male/_female names, or {'unisex': path} for one GLB."""
    shapes = {s: g for g in piece.glbs for s in ('male', 'female') if g.stem.lower().endswith('_' + s)}
    return shapes or {'unisex': piece.glbs[0]}


def _shas(glbs: list[Path]) -> set[str]:
    return {_sha(g) for g in glbs}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
