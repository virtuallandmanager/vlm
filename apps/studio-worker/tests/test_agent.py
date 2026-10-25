import os
import sys
import time
from pathlib import Path

import pytest

from studio_worker import agent
from studio_worker.agent import Usage, agent_env, run_agent

FAKES = Path(__file__).parent / 'fakes'
LIMITS = {'timeoutSec': 30, 'maxTurns': 80, 'costCeilingUsd': 3.0}


def fake(name: str) -> list[str]:
    return [sys.executable, str(FAKES / 'replay.py'), str(FAKES / name)]


def run(tmp_path, agent_name, fixture, limits=LIMITS, before=None, progress=None):
    return run_agent(agent_name, 'claude-opus-5-5' if agent_name == 'claude' else 'gpt-6.1-sol', 'make a cap',
                     None, before, limits, (progress if progress is not None else []).append,
                     command=fake(fixture), as_user=None, cwd=tmp_path)


def test_agent_env_has_only_its_key():
    base = {'ANTHROPIC_API_KEY': 'sk-ant', 'OPENAI_API_KEY': 'sk-oai', 'STUDIO_WORKER_TOKEN': 'tok',
            'HTTPS_PROXY': 'http://127.0.0.1:8888', 'PATH': '/usr/bin'}
    claude = agent_env('claude', base)
    assert claude['ANTHROPIC_API_KEY'] == 'sk-ant'
    assert 'OPENAI_API_KEY' not in claude and 'STUDIO_WORKER_TOKEN' not in claude
    assert claude['CLAUDE_CONFIG_DIR'] == str(agent.DESIGN / '.claude-home')
    assert claude['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] == '1'
    codex = agent_env('codex', base)
    assert codex['CODEX_API_KEY'] == 'sk-oai'
    assert not {'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'STUDIO_WORKER_TOKEN'} & set(codex)
    assert codex['CODEX_HOME'] == str(agent.DESIGN / '.codex-home')
    assert claude['HTTPS_PROXY'] == codex['HTTPS_PROXY'] == 'http://127.0.0.1:8888'


def test_progress_streams_from_claude(tmp_path):
    progress = []
    r = run(tmp_path, 'claude', 'claude_stream.jsonl', progress=progress)
    command = ('blender -b /opt/assets/AvatarShape_A.blend --python build_cap.py -- --out out/hat/neon_cap_male.glb '
               '--visor glow --and-a-long-tail')
    assert progress == ['Reading the wearable skill.', 'Running: ' + command[:80],
                        'The cap is built and passes the checker.']
    assert r.outcome == 'ok' and r.session == 'sess-claude-1'
    assert r.reply == 'The cap is built and passes the checker.'
    assert r.cost_usd == pytest.approx(0.0125)


def test_progress_streams_from_codex(tmp_path):
    progress = []
    r = run(tmp_path, 'codex', 'codex_stream.jsonl', progress=progress)
    assert progress == ['Reading the wearable skill.',
                        'Running: cat /work/design/.agents/skills/creating-dcl-wearables/SKILL.md',
                        'The cap is built.']
    assert r.outcome == 'ok' and r.session == 'thread-codex-1' and r.reply == 'The cap is built.'
    assert r.usage.input == 15000 and r.usage.cached_input == 100000 and r.usage.output == 3000


def test_claude_stopped_at_cost_ceiling(tmp_path):
    start = time.monotonic()
    r = run(tmp_path, 'claude', 'claude_runaway.jsonl', limits={**LIMITS, 'costCeilingUsd': 0.05})
    assert r.outcome == 'ceiling'
    assert time.monotonic() - start < 5
    assert r.cost_usd == pytest.approx(0.06)
    assert r.session == 'sess-claude-2'


def test_timeout_kills_the_process_group(tmp_path):
    r = run(tmp_path, 'claude', 'hang_with_child.jsonl', limits={**LIMITS, 'timeoutSec': 1})
    assert r.outcome == 'timeout'
    pid = int((tmp_path / 'child.pid').read_text())
    for _ in range(20):  # the orphaned child is reaped by init a moment after the kill
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        pytest.fail(f'child {pid} still running')


def test_resumed_prompt_is_charged_its_share(tmp_path):
    before = Usage(input=5, cached_input=400, cache_write=600, output=20, turns=1, cost_usd=0.0050)
    r = run(tmp_path, 'claude', 'claude_stream.jsonl', before=before)
    assert (r.usage.input, r.usage.cached_input, r.usage.cache_write, r.usage.output) == (10, 600, 400, 30)
    assert r.cost_usd == pytest.approx(0.0075)
    assert r.session_total.cost_usd == pytest.approx(0.0125)
