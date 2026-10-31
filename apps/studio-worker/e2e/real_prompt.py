#!/usr/bin/env python3
"""Runs the worker against real agents: the spike's brief 01 (build a hat) then brief 02 (tweak it), each on a fresh
worker start that restores the workspace, with tests/fake_api.py standing in for Virvi's API. Spends about $1 per agent
(about $2 for Grok).

    python3 /opt/e2e/real_prompt.py --agent claude [--then codex] [--out /out]

Inside the image, through the entrypoint (so the network is locked down), with tests/ and e2e/ mounted at /opt:
    docker run --rm --platform linux/amd64 --cap-add NET_ADMIN --env-file apps/studio-worker/.env \
      -v $PWD/apps/studio-worker/tests:/opt/tests:ro -v $PWD/apps/studio-worker/e2e:/opt/e2e:ro -v /tmp/real:/out \
      vlm-studio-worker:dev python3 /opt/e2e/real_prompt.py --agent claude
Prints each job's progress and result, checks them, and exits non-zero if a check fails.
"""
import argparse
import io
import json
import re
import secrets
import shutil
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tests'))
import fake_api  # noqa: E402
from studio_worker import jobs  # noqa: E402
from studio_worker.config import DESIGN  # noqa: E402
from studio_worker.render import is_blank  # noqa: E402
from studio_worker.workspace import state_dir  # noqa: E402

MODELS = {'claude': 'claude-opus-5-5', 'codex': 'gpt-6.1-sol', 'grok': 'grok-build-0.1'}
# Grok counts each tool call as a turn and costs more per tweak (apps/server/src/studio/designs.ts promptLimits)
MAX_TURNS = {'claude': 80, 'codex': 80, 'grok': 150}
TWEAK_BUDGET = {'claude': 0.5, 'codex': 0.5, 'grok': 1.5}
BRIEFS = ['A rounded cyberpunk cap with a glowing neon visor strip across the front. Make it for both body shapes.',
          'Make the visor strip pink and the cap matte black.']


def fresh_design() -> None:
    """A new design, as on a new machine: fly.sh runs one agent after another on the same one."""
    shutil.rmtree(state_dir(DESIGN), ignore_errors=True)
    for f in DESIGN.iterdir():
        if f.name not in ('.claude', '.agents'):  # the image's skills
            shutil.rmtree(f) if f.is_dir() and not f.is_symlink() else f.unlink()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', required=True, choices=list(MODELS))
    ap.add_argument('--then', choices=list(MODELS), help='the agent for the tweak (default: the same one)')
    ap.add_argument('--out', type=Path, default=Path('/out'))
    a = ap.parse_args()
    agents = [a.agent, a.then or a.agent]
    failures = []

    def expect(ok: bool, what: str):
        print(('OK   ' if ok else 'FAIL ') + what, flush=True)
        if not ok:
            failures.append(what)

    fresh_design()
    token = secrets.token_urlsafe(24)
    with fake_api.serve(token=token, design='real-design') as api:
        api.on_event = lambda job, e: print(f"  [{job}] {e.get('phase') or e.get('text')}", flush=True)
        env = {'VIRVI_API_URL': api.url, 'STUDIO_WORKER_TOKEN': token, 'STUDIO_DESIGN_ID': 'real-design',
               'STUDIO_IDLE_EXIT_SEC': '3'}
        for n, (agent, words) in enumerate(zip(agents, BRIEFS), 1):
            job_id = f'job-{n}-{agent}'
            api.jobs.append({'jobId': job_id, 'type': 'prompt', 'kind': 'wearable', 'agent': agent,
                             'model': MODELS[agent], 'prompt': words, 'selectedSlots': ['hat'],
                             'limits': {'timeoutSec': 1500, 'maxTurns': MAX_TURNS[agent], 'costCeilingUsd': 3.0},
                             'render': None})
            print(f'--- {job_id}: {words}', flush=True)
            jobs.main({**env})  # a fresh worker start each time: the workspace comes back from the API
            r = api.results[-1]
            summary = {k: r[k] for k in ('outcome', 'costUsd', 'wallSec', 'skillsSha', 'error')}
            print(json.dumps(summary), '\n  reply:', r['reply'][:400], flush=True)
            hat = next((p for p in r['pieces'] if p['category'] == 'hat'), None)
            expect(r['outcome'] == 'ok', f'{job_id} outcome ok')
            expect(bool(re.fullmatch(r'[0-9a-f]{40}', r['skillsSha'] or '')), f'{job_id} records the skills SHA')
            expect(bool(hat and hat['changed']), f'{job_id} hat changed')
            expect(bool(hat and hat['checker']['pass']), f'{job_id} hat passes the checker')
            frames = sorted(k for k in api.files if k.startswith(f'{job_id}/renders/hat/spin-male-default/'))
            blank = sum(is_blank(Image.open(io.BytesIO(api.files[k]))) for k in frames)
            expect(len(frames) == 36 and blank == 0, f'{job_id} 36 non-blank spin frames ({len(frames)}, {blank} blank)')
            if n == 2:
                budget = TWEAK_BUDGET[agent]
                expect(r['costUsd'] is not None and r['costUsd'] < budget,
                       f'{job_id} tweak under ${budget:.2f} (${r["costUsd"]})')
            out = a.out / job_id
            out.mkdir(parents=True, exist_ok=True)
            for k in frames[::9]:
                (out / Path(k).name).write_bytes(api.files[k])
            (out / 'result.json').write_text(json.dumps(r, indent=2))
        state = json.loads((state_dir(DESIGN) / 'state.json').read_text())
        expect([m['role'] for m in state['messages']] == ['user', 'agent', 'user', 'agent'], 'the conversation continues')
        if agents[0] != agents[1]:
            homes = DESIGN / ('.codex-home' if agents[1] == 'codex' else '.claude-home')
            carried = any('Conversation so far:' in f.read_text(errors='ignore') for f in homes.rglob('*.jsonl'))
            expect(carried, f'{agents[1]} was given the conversation it missed')
    print('PASSED' if not failures else f'FAILED: {failures}', flush=True)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
