"""The worker's job loop: restore the design's workspace, take jobs from Virvi's API until it has been idle for
STUDIO_IDLE_EXIT_SEC, then exit so the machine stops. See CONTRACT.md for the API.

A prompt job runs the agent, checks and renders what changed, uploads it, saves the workspace, and only then posts
its result. A render job renders a view of the workspace's current pieces and saves nothing. A finalize job builds
paid packages from Virvi's copies of the paid files (finalize.py) and saves nothing either.
"""
import copy
import mimetypes
import os
import sys
import tempfile
import time
import traceback
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Mapping

from . import render as renderer
from .agent import Usage, run_agent
from .api import Api, ApiError
from .config import AGENT_USER, DESIGN, skills_sha
from .finalize import Tools, finalize_job
from .instructions import closing
from .pieces import Piece, collect, glbs_by_shape, glbs_outside, new_hashes
from .workspace import load_state, pack, prompt_with_context, save_state, state_dir, unpack

IDLE_EXIT_SEC = 600
POLL_SEC = 2.0
DEFAULT_LIMITS = {'timeoutSec': 1500, 'maxTurns': 80, 'costCeilingUsd': 3.0}


def run_job(job: dict, client: Api, design: Path, render_fn: Callable = renderer.render,
            command: list[str] | None = None, as_user: str | None = AGENT_USER, tools: Tools | None = None) -> dict:
    """Runs one job and posts its Result, which it also returns."""
    start = time.monotonic()
    result = {'jobId': job['jobId'], 'outcome': 'error', 'agent': job.get('agent'), 'model': job.get('model'),
              'skillsSha': skills_sha(), 'wallSec': None, 'tokens': None, 'costUsd': None, 'reply': '',
              'proposal': None, 'pieces': [], 'error': None}
    try:
        if job.get('type') == 'render':
            _render_job(job, client, Path(design), render_fn, result)
        elif job.get('type') == 'finalize':
            with tempfile.TemporaryDirectory(prefix='studio-final-') as stage:
                finalize_job(job, client, render_fn, tools or Tools.real(), result, Path(stage))
        else:
            _prompt_job(job, client, Path(design), render_fn, command, as_user, result)
    except Exception as e:  # the result still goes out, so the design isn't left waiting
        result.update(outcome='error', error=f'worker: {type(e).__name__}: {e}')
        traceback.print_exc(file=sys.stderr)
    result['wallSec'] = round(time.monotonic() - start, 1)
    client.post_result(job['jobId'], result)
    return result


def _prompt_job(job, client, design, render_fn, command, as_user, result):
    job_id, agent, kind = job['jobId'], job['agent'], job.get('kind', 'wearable')
    state_path = state_dir(design)
    state = load_state(state_path)
    saved = copy.deepcopy(state)
    proposal_file = design / 'out' / 'proposal.json'
    if os.path.lexists(proposal_file):  # an earlier prompt's proposal has been answered; don't read it as this one's
        os.unlink(proposal_file)
    totals = state.totals.get(agent)
    before = Usage(**totals) if totals else None
    prompt = prompt_with_context(state, agent, job['prompt']) + closing(kind, job.get('selectedSlots'))
    limits = {**DEFAULT_LIMITS, **{k: v for k, v in (job.get('limits') or {}).items() if v is not None}}

    _phase(client, job_id, 'building')
    started = time.time()
    run = run_agent(agent, job['model'], prompt, state.sessions.get(agent), before, limits,
                    lambda text: _send(client, job_id, {'type': 'progress', 'text': text}),
                    command=command, as_user=as_user, cwd=design)
    usage = run.usage
    result.update(reply=run.reply, costUsd=run.cost_usd, tokens=usage and {
        'input': usage.input, 'cachedInput': usage.cached_input, 'cacheWrite': usage.cache_write,
        'output': usage.output})

    _phase(client, job_id, 'checking')
    with tempfile.TemporaryDirectory(prefix='studio-stage-') as stage:
        pieces, proposal, error = collect(design, kind, state.hashes, stage=Path(stage)) \
            if run.outcome == 'ok' else ([], None, None)
        changed = [p for p in pieces if p.changed]
        if run.outcome == 'ok' and not error and not changed and not proposal:
            elsewhere = glbs_outside(design, started)
            if elsewhere:
                error = 'GLBs exported outside out/<category>/: ' + ', '.join(
                    g.relative_to(design).as_posix() for g in elsewhere)
        renders, render_errors, uploaded = {}, [], set()
        if changed and not proposal and not error:
            _phase(client, job_id, 'rendering')
            for p in changed:
                view = {'bodyShape': 'male', 'outfit': 'default', 'emote': None,
                        'mode': 'emote' if kind == 'emote' else 'spin'}
                count, problem = _render_and_upload(client, job_id, p, view, render_fn)
                if problem:  # not uploaded and not recorded: the next prompt sees it as changed and tries again
                    render_errors.append(f'{p.category}: {problem}')
                    continue
                _upload_piece(client, job_id, p)
                renders[p.category] = count
                uploaded.add(p.category)

        _phase(client, job_id, 'saving')
        state.messages += [{'role': 'user', 'agent': agent, 'text': job['prompt']}]
        if run.reply:
            state.messages += [{'role': 'agent', 'agent': agent, 'text': run.reply}]
        if run.session:
            state.sessions[agent] = run.session
        if run.session_total:
            state.totals[agent] = asdict(run.session_total)
        state.last_agent = agent
        # only what reached Virvi counts as the design's current pieces
        state.hashes.update({c: h for c, h in new_hashes(pieces).items() if c in uploaded})
        save_state(state_path, state)
        try:
            client.put_workspace(pack(design, state_path))
        except ApiError as e:  # nothing may claim this revision is saved, here or in the next prompt
            save_state(state_path, saved)
            result.update(outcome='error', error=f'workspace save failed: {e}')
            return

        result['proposal'] = proposal
        result['pieces'] = [_piece_result(p, renders.get(p.category), p.category in uploaded) for p in pieces]
    if run.outcome != 'ok':
        result.update(outcome=run.outcome, error=run.error)
    elif error:
        result.update(outcome='error', error=error)
    elif proposal:
        result['outcome'] = 'needs_input'
    elif render_errors:
        result.update(outcome='error', error='render failed: ' + '; '.join(render_errors))
    else:
        result['outcome'] = 'ok' if uploaded else 'no_change'


def _render_job(job, client, design, render_fn, result):
    spec, kind = job['render'], job.get('kind', 'wearable')
    with tempfile.TemporaryDirectory(prefix='studio-stage-') as stage:
        pieces, _, error = collect(design, kind, {}, run_checker=False, stage=Path(stage))
        if error:
            result['error'] = error
            return
        wanted = {p.category: p for p in pieces}
        missing = [c for c in spec['categories'] if c not in wanted]
        if missing:
            result['error'] = f'no piece for {", ".join(missing)}'
            return
        view = {'bodyShape': spec.get('bodyShape') or 'male', 'outfit': spec.get('outfit') or 'default',
                'emote': spec.get('emote'), 'mode': 'emote' if kind == 'emote' else 'spin'}
        _phase(client, job['jobId'], 'rendering')
        problems = []
        for category in spec['categories']:
            count, problem = _render_and_upload(client, job['jobId'], wanted[category], view, render_fn)
            result['pieces'].append({'category': category, 'renders': count})
            if problem:
                problems.append(f'{category}: {problem}')
    result.update(outcome='error' if problems else 'ok', error='; '.join(problems) or None)


def view_key(view: dict) -> str:
    return '-'.join([view['mode'], view['bodyShape'], view['outfit']] + ([view['emote']] if view.get('emote') else []))


def _render_and_upload(client, job_id, piece: Piece, view, render_fn) -> tuple[dict, str | None]:
    """Renders one piece's view and uploads its frames: ({view key: frames}, error)."""
    key = view_key(view)
    with tempfile.TemporaryDirectory() as tmp:
        r = render_fn([{'category': piece.category, 'glbs': glbs_by_shape(piece), 'meta': piece.meta}], view,
                      Path(tmp) / key)
        if not r['ok']:
            return {key: 0}, r['error']
        for i, frame in enumerate(r['frames']):
            client.put_file(job_id, f'renders/{piece.category}/{key}/{i:03d}{frame.suffix}', frame.read_bytes(),
                            mimetypes.guess_type(frame.name)[0] or 'image/webp')
    return {key: len(r['frames'])}, None


def _upload_piece(client, job_id, piece: Piece) -> None:
    for f in piece.glbs + [piece.glbs[0].parent / 'piece.json']:
        client.put_file(job_id, f'pieces/{piece.category}/{f.name}', f.read_bytes(),
                        'model/gltf-binary' if f.suffix == '.glb' else 'application/json')
    client.put_file(job_id, f'checks/{piece.category}.txt', piece.checker.get('report', '').encode(), 'text/plain')


def _piece_result(p: Piece, renders: dict | None, uploaded: bool) -> dict:
    files = [f'pieces/{p.category}/{f.name}' for f in p.glbs] + [f'pieces/{p.category}/piece.json',
                                                                 f'checks/{p.category}.txt']
    return {'category': p.category, 'changed': p.changed, 'changeKind': p.meta.get('changeKind'), 'meta': p.meta,
            'checker': {k: p.checker.get(k) for k in ('pass', 'failures', 'warnings')},
            'files': files if uploaded else [], 'renders': renders or {}}


def _phase(client, job_id, phase):
    _send(client, job_id, {'type': 'phase', 'phase': phase})


def _send(client, job_id, event):
    """Progress is best effort: a dropped event never fails the job."""
    try:
        client.event(job_id, event)
    except ApiError as e:
        print(f'event not sent: {e}', file=sys.stderr)


def main(env: Mapping[str, str] | None = None, design: Path | None = None, poll_sec: float = POLL_SEC,
         **run_kwargs) -> int:
    env = os.environ if env is None else env
    design = Path(design or DESIGN)
    client = Api(env['VIRVI_API_URL'], env['STUDIO_WORKER_TOKEN'], env['STUDIO_DESIGN_ID'])
    idle_exit = float(env.get('STUDIO_IDLE_EXIT_SEC', IDLE_EXIT_SEC))
    data = client.get_workspace()
    if data:
        unpack(data, design, state_dir(design))
    design.mkdir(parents=True, exist_ok=True)
    print(f'studio worker: design {client.design}, workspace {"restored" if data else "new"}', file=sys.stderr)
    idle_since = time.monotonic()
    while True:
        try:
            job = client.next_job()
        except ApiError as e:
            print(f'polling failed: {e}', file=sys.stderr)
            job = None
        if job:
            print(f"job {job['jobId']} ({job.get('type')}) started", file=sys.stderr)
            try:
                result = run_job(job, client, design, **run_kwargs)
            except ApiError as e:  # the result itself couldn't be posted; the API times the job out
                print(f"job {job['jobId']}: result not posted: {e}", file=sys.stderr)
                idle_since = time.monotonic()
                continue
            print(f"job {job['jobId']} -> {result['outcome']}" + (f": {result['error']}" if result['error'] else ''),
                  file=sys.stderr)
            idle_since = time.monotonic()
            continue
        if time.monotonic() - idle_since >= idle_exit:
            print(f'idle for {idle_exit:.0f}s, exiting', file=sys.stderr)
            return 0
        time.sleep(poll_sec)
