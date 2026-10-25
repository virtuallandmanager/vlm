#!/usr/bin/env python3
"""Run one Design Studio brief through one agent and record what it cost.

    python3 harness.py --agent claude|codex --brief briefs/01-hat-build.md --out /work/runs/claude-01 [--resume /work/runs/claude-00]

Writes <out>/result.json: outcome, wall time, turns, tokens, dollars, and the skills checker's verdict on the GLBs.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass
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
    """Totals modelUsage, which total_cost_usd is computed from; the top-level usage can miss calls."""
    models = (obj.get('modelUsage') or {}).values()
    if not models:
        u = obj.get('usage') or {}
        return Usage(input=u.get('input_tokens', 0), cached_input=u.get('cache_read_input_tokens', 0),
                     cache_write=u.get('cache_creation_input_tokens', 0), output=u.get('output_tokens', 0),
                     turns=obj.get('num_turns', 0), cost_usd=obj.get('total_cost_usd'))
    total = lambda k: sum(m.get(k, 0) for m in models)
    return Usage(input=total('inputTokens'), cached_input=total('cacheReadInputTokens'),
                 cache_write=total('cacheCreationInputTokens'), output=total('outputTokens'),
                 turns=obj.get('num_turns', 0), cost_usd=obj.get('total_cost_usd'))


def parse_codex_events(lines: list[str]) -> Usage | None:
    """The usage on the last turn.completed event, which is the session's running total; None when there is none
    (the run failed before any turn ended).

    Codex's input_tokens includes its cached and cache-write tokens, and output_tokens its reasoning tokens."""
    turns = [e for e in (_json(l) for l in lines) if e and e.get('type') == 'turn.completed' and e.get('usage')]
    if not turns:
        return None
    u = turns[-1]['usage']
    cached, written = u.get('cached_input_tokens', 0), u.get('cache_write_input_tokens', 0)
    return Usage(input=u.get('input_tokens', 0) - cached - written, cached_input=cached, cache_write=written,
                 output=u.get('output_tokens', 0), turns=len(turns))


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


def agent_command(agent: str, prompt: str, session: str | None, model: str | None = None) -> list[str]:
    if agent == 'claude':
        cmd = ['claude', '-p', prompt, '--output-format', 'json', '--max-turns', str(MAX_TURNS),
               '--dangerously-skip-permissions']  # only inside the throwaway container
        return cmd + (['--resume', session] if session else []) + (['--model', model] if model else [])
    base = ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox']
    base += ['-m', model] if model else []
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
    before = _session_total(resume)
    if resume:  # continue the same conversation and working files
        session = json.loads((Path(resume) / 'result.json').read_text()).get('session')
        if not out.exists():
            subprocess.run(['cp', '-a', str(resume), str(out)], check=True)
    else:
        session = None
        out.mkdir(parents=True, exist_ok=True)
    for d in ('.claude', '.agents'):  # the skills installed into /work, visible from the run directory
        if (WORK / d).exists() and not (out / d).exists():
            (out / d).symlink_to(WORK / d)
    cmd = command or agent_command(agent, words + CLOSING, session, model)
    env = dict(os.environ, **_agent_home(agent, out))
    if agent == 'codex':  # codex exec reads its key from CODEX_API_KEY, not OPENAI_API_KEY
        env.setdefault('CODEX_API_KEY', env.get('OPENAI_API_KEY', ''))

    start = time.monotonic()
    result = {'agent': agent, 'model': model, 'brief': Path(brief_path).name, 'skillsSha': _skills_sha(),
              'outcome': 'error', 'wallSec': None, 'turns': None, 'tokens': None, 'costUsd': None,
              'checker': {'ran': False}, 'glbs': [], 'session': session, 'sessionTotal': None, 'error': None}
    try:
        p = subprocess.run(cmd, cwd=out, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=timeout)
        stdout = p.stdout
    except subprocess.TimeoutExpired as e:
        result.update(outcome='timeout', wallSec=round(time.monotonic() - start, 1))
        stdout = (e.stdout or b'').decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
        (out / 'agent.log').write_text(stdout)
        return _write(out, result)
    result['wallSec'] = round(time.monotonic() - start, 1)
    (out / 'agent.log').write_text(stdout + '\n--- stderr ---\n' + p.stderr)

    scored, failed = score(agent, stdout, before, prices, model)
    result.update(scored)
    if result['tokens'] is None or failed or p.returncode != 0:
        result['error'] = (p.stderr or stdout)[-2000:]
        return _write(out, result)

    result['glbs'] = [str(g.relative_to(out)) for g in sorted(out.rglob('*.glb'))]
    result['checker'] = run_checker(meta, out)
    result['outcome'] = 'ok' if result['glbs'] else 'no_output'
    return _write(out, result)


def score(agent: str, stdout: str, before: Usage | None = None, prices: dict | None = None,
          model: str | None = None) -> tuple[dict, bool]:
    """Reads the CLI's output into result.json fields, and whether the CLI reported a failure.

    Both CLIs report the whole session's usage, so a resumed run is charged its total less `before`."""
    fields, usage, failed = {}, None, False
    if agent == 'claude':
        obj = _json(stdout.strip().splitlines()[-1]) if stdout.strip() else None
        if obj:
            usage = parse_claude_result(obj)
            fields['session'] = obj.get('session_id')
            fields['model'] = model or next(iter(obj.get('modelUsage') or {}), None)
            failed = bool(obj.get('is_error'))
    else:
        lines = stdout.splitlines()
        usage = parse_codex_events(lines)
        started = next((e for e in map(_json, lines) if e and e.get('type') == 'thread.started'), None)
        if started:
            fields['session'] = started.get('thread_id')
        failed = any((_json(l) or {}).get('type') == 'turn.failed' for l in lines)
    if not usage:
        return fields, failed
    if usage.cost_usd is None:
        usage.cost_usd = cost_usd(usage, prices or _prices(), fields.get('model') or model or f'{agent}-default')
    fields['sessionTotal'] = {**asdict(usage), 'costUsd': usage.cost_usd}
    del fields['sessionTotal']['cost_usd']
    own = usage
    if before:
        own = Usage(input=usage.input - before.input, cached_input=usage.cached_input - before.cached_input,
                    cache_write=usage.cache_write - before.cache_write, output=usage.output - before.output,
                    turns=usage.turns, cost_usd=None if usage.cost_usd is None or before.cost_usd is None
                    else round(usage.cost_usd - before.cost_usd, 6))
    fields.update(turns=own.turns, costUsd=own.cost_usd,
                  tokens={'input': own.input, 'cachedInput': own.cached_input, 'cacheWrite': own.cache_write,
                          'output': own.output})
    return fields, failed


def rescore(out: Path, resume: Path | None = None) -> dict:
    """Re-reads a finished run's agent.log with the current scoring, without running the agent again."""
    result = json.loads((Path(out) / 'result.json').read_text())
    stdout = (Path(out) / 'agent.log').read_text().split('\n--- stderr ---\n')[0]
    result.update(score(result['agent'], stdout, _session_total(resume), model=result['model'])[0])
    return _write(Path(out), result)


def _session_total(resume: Path | None) -> Usage | None:
    if not resume:
        return None
    t = json.loads((Path(resume) / 'result.json').read_text()).get('sessionTotal')
    return t and Usage(input=t['input'], cached_input=t['cached_input'], cache_write=t['cache_write'],
                       output=t['output'], turns=t['turns'], cost_usd=t['costUsd'])


def _agent_home(agent: str, out: Path) -> dict:
    """The agent's own state (its sessions) lives in the run directory, so a resumed run, copied from it, has them.

    Claude Code files sessions under projects/<working directory>; a resumed run works in a new directory, so the
    copied sessions are filed under that one too."""
    if agent == 'codex':
        home = out / '.codex-home'
        home.mkdir(exist_ok=True)
        return {'CODEX_HOME': str(home)}
    home = out / '.claude-home'
    projects = home / 'projects'
    here = projects / re.sub(r'[^A-Za-z0-9]', '-', os.path.realpath(out))
    here.mkdir(parents=True, exist_ok=True)
    for f in projects.glob('*/*.jsonl'):
        if f.parent != here and not (here / f.name).exists():
            shutil.copy2(f, here / f.name)
    return {'CLAUDE_CONFIG_DIR': str(home)}


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
    ap.add_argument('--rescore', action='store_true', help="re-read a finished run's agent.log; runs nothing")
    a = ap.parse_args()
    r = rescore(a.out, a.resume) if a.rescore else run(a.agent, a.brief, a.out, resume=a.resume, model=a.model)
    print(json.dumps({k: r[k] for k in ('outcome', 'wallSec', 'turns', 'costUsd')}))
