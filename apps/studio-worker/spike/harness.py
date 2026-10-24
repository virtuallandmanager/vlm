#!/usr/bin/env python3
"""Run one Design Studio brief through one agent and record what it cost.

    python3 harness.py --agent claude|codex --brief briefs/01-hat-build.md --out /work/runs/claude-01 [--resume /work/runs/claude-00]

Writes <out>/result.json: outcome, wall time, turns, tokens, dollars, and the skills checker's verdict on the GLBs.
"""
import argparse
import json
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

SKILLS = Path('/opt/skills')
WORK = Path('/work')
TIMEOUT_SEC = 1500  # 25 minutes, the plan's hard cap per run
MAX_TURNS = 80

# The studio's fixed instruction after the user's words.
CLOSING = (
    '\n\nUse the dcl-avatar-skills. The official Decentraland base avatar .blend files are in /work/assets. '
    'Build it in Blender (run it headless: `blender -b`), export the GLBs to ./out, run the checker, and stop.'
)


@dataclass
class Usage:
    input: int
    cached_input: int
    cache_write: int
    output: int
    turns: int
    cost_usd: float | None = None


def parse_claude_result(obj: dict) -> Usage:
    u = obj.get('usage') or {}
    return Usage(input=u.get('input_tokens', 0), cached_input=u.get('cache_read_input_tokens', 0),
                 cache_write=u.get('cache_creation_input_tokens', 0), output=u.get('output_tokens', 0),
                 turns=obj.get('num_turns', 0), cost_usd=obj.get('total_cost_usd'))


def parse_codex_events(lines: list[str]) -> Usage | None:
    """Sums the usage on every turn.completed event; None when there is none (the run failed before any turn ended)."""
    turns = [e for e in (_json(l) for l in lines) if e and e.get('type') == 'turn.completed' and e.get('usage')]
    if not turns:
        return None
    total = lambda k: sum(t['usage'].get(k, 0) for t in turns)
    return Usage(input=total('input_tokens'), cached_input=total('cached_input_tokens'), cache_write=0,
                 output=total('output_tokens'), turns=len(turns))


def cost_usd(usage: Usage, prices: dict, model: str) -> float | None:
    p = prices.get(model)
    if not p:
        return None
    per_m = lambda n, rate: n * rate / 1_000_000
    return round(per_m(usage.input, p['input']) + per_m(usage.cached_input, p['cachedInput'])
                 + per_m(usage.cache_write, p['cacheWrite']) + per_m(usage.output, p['output']), 4)


def read_brief(path: Path) -> tuple[dict, str]:
    """`key: value` lines up to the first blank line, then the user's words."""
    head, _, body = Path(path).read_text().partition('\n\n')
    meta = dict(l.split(':', 1) for l in head.splitlines() if ':' in l)
    return {k.strip(): v.strip() for k, v in meta.items()}, body.strip()


def agent_command(agent: str, prompt: str, session: str | None) -> list[str]:
    if agent == 'claude':
        cmd = ['claude', '-p', prompt, '--output-format', 'json', '--max-turns', str(MAX_TURNS),
               '--dangerously-skip-permissions']  # only inside the throwaway container
        return cmd + (['--resume', session] if session else [])
    base = ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']
    return base + (['resume', session, prompt] if session else [prompt])


def run_checker(meta: dict, out: Path) -> dict:
    glbs = sorted(out.rglob('*.glb'))
    if not glbs:
        return {'ran': False}
    if meta.get('kind') == 'emote':
        cmd = ['python3', str(SKILLS / 'skills/creating-dcl-emotes/scripts/check_emote.py'), *map(str, glbs)]
        cmd += ['--loop'] if meta.get('loop') == 'yes' else []
    else:
        cmd = ['python3', str(SKILLS / 'skills/creating-dcl-wearables/scripts/check_wearable.py'), *map(str, glbs),
               '--category', meta.get('category', '')]
        cmd += ['--hides', meta['hides']] if meta.get('hides') else []
    p = subprocess.run(cmd, capture_output=True, text=True)
    levels = [l.split()[0] for l in p.stdout.splitlines() if l.startswith('  ') and l.split()]
    return {'ran': True, 'pass': p.returncode == 0, 'warnings': levels.count('WARN'), 'failures': levels.count('FAIL'),
            'report': p.stdout + p.stderr}


def run(agent: str, brief_path: Path, out: Path, command: list[str] | None = None, timeout: int = TIMEOUT_SEC,
        resume: Path | None = None, prices: dict | None = None, model: str | None = None) -> dict:
    out = Path(out)
    meta, words = read_brief(brief_path)
    if resume:  # continue the same conversation and working files
        prev = json.loads((Path(resume) / 'result.json').read_text())
        session = prev.get('session')
        if not out.exists():
            subprocess.run(['cp', '-a', str(resume), str(out)], check=True)
    else:
        session = None
        out.mkdir(parents=True, exist_ok=True)
    for d in ('.claude', '.agents'):  # the skills installed into /work, visible from the run directory
        if (WORK / d).exists() and not (out / d).exists():
            (out / d).symlink_to(WORK / d)
    cmd = command or agent_command(agent, words + CLOSING, session)

    start = time.monotonic()
    result = {'agent': agent, 'model': model, 'brief': Path(brief_path).name, 'skillsSha': _skills_sha(),
              'outcome': 'error', 'wallSec': None, 'turns': None, 'tokens': None, 'costUsd': None,
              'checker': {'ran': False}, 'glbs': [], 'session': session, 'error': None}
    try:
        p = subprocess.run(cmd, cwd=out, capture_output=True, text=True, timeout=timeout)
        stdout = p.stdout
    except subprocess.TimeoutExpired as e:
        result.update(outcome='timeout', wallSec=round(time.monotonic() - start, 1))
        stdout = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        (out / 'agent.log').write_text(stdout)
        return _write(out, result)
    result['wallSec'] = round(time.monotonic() - start, 1)
    (out / 'agent.log').write_text(stdout + '\n--- stderr ---\n' + p.stderr)

    usage, failed = None, p.returncode != 0
    if agent == 'claude':
        obj = _json(stdout.strip().splitlines()[-1]) if stdout.strip() else None
        if obj:
            usage = parse_claude_result(obj)
            result['session'] = obj.get('session_id')
            result['model'] = model or next(iter(obj.get('modelUsage') or {}), None)
            failed = failed or bool(obj.get('is_error'))
    else:
        lines = stdout.splitlines()
        usage = parse_codex_events(lines)
        started = next((e for e in map(_json, lines) if e and e.get('type') == 'thread.started'), None)
        result['session'] = started and started.get('thread_id')
        failed = failed or any((_json(l) or {}).get('type') == 'turn.failed' for l in lines)
    if usage:
        result['turns'] = usage.turns
        result['tokens'] = {'input': usage.input, 'cachedInput': usage.cached_input, 'cacheWrite': usage.cache_write,
                            'output': usage.output}
        result['costUsd'] = usage.cost_usd if usage.cost_usd is not None else cost_usd(
            usage, prices or _prices(), result['model'] or f'{agent}-default')
    if usage is None or failed:
        result['error'] = (p.stderr or stdout)[-2000:]
        return _write(out, result)

    result['glbs'] = [str(g.relative_to(out)) for g in sorted(out.rglob('*.glb'))]
    result['checker'] = run_checker(meta, out)
    result['outcome'] = 'ok' if result['glbs'] else 'no_output'
    return _write(out, result)


def _write(out: Path, result: dict) -> dict:
    (out / 'result.json').write_text(json.dumps(result, indent=2))
    return result


def _json(line: str):
    try:
        return json.loads(line)
    except (json.JSONDecodeError, TypeError):
        return None


def _prices() -> dict:
    return json.loads((Path(__file__).parent / 'prices.json').read_text())['models']


def _skills_sha() -> str | None:
    p = subprocess.run(['git', '-C', str(SKILLS), 'rev-parse', 'HEAD'], capture_output=True, text=True)
    return p.stdout.strip() or None


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', required=True, choices=['claude', 'codex'])
    ap.add_argument('--brief', required=True, type=Path)
    ap.add_argument('--out', required=True, type=Path)
    ap.add_argument('--resume', type=Path)
    ap.add_argument('--model', help='recorded model name, and the price-table key when the CLI does not report one')
    a = ap.parse_args()
    r = run(a.agent, a.brief, a.out, resume=a.resume, model=a.model)
    print(json.dumps({k: r[k] for k in ('outcome', 'wallSec', 'turns', 'costUsd')}))
