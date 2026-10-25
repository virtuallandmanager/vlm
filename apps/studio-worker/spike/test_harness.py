import json
import os
import time
from pathlib import Path

import harness
from harness import Usage, cost_usd, parse_claude_result, parse_codex_events

FIX = Path(__file__).parent / 'fixtures'
PRICES = {'m': {'input': 4.0, 'cachedInput': 0.2, 'cacheWrite': 5.0, 'output': 20.0}}


def test_parse_claude_result():
    obj = json.loads((FIX / 'claude_result.json').read_text())
    u = parse_claude_result(obj)
    assert u.turns == obj['num_turns']
    assert u.cost_usd == obj['total_cost_usd']
    assert (u.input, u.cached_input, u.cache_write, u.output) == (21000, 4200000, 180000, 61000)


def test_parse_codex_events():
    u = parse_codex_events((FIX / 'codex_events.jsonl').read_text().splitlines())
    # Codex's input_tokens includes the cached and cache-write tokens; Usage keeps the three apart, as Claude reports them
    assert (u.input, u.cached_input, u.cache_write, u.output) == (250000, 2900000, 50000, 50000)
    assert u.turns == 2
    assert u.cost_usd is None  # Codex doesn't report dollars; cost_usd() prices it


def test_codex_no_usage_is_null(tmp_path):
    lines = (FIX / 'codex_no_usage.jsonl').read_text().splitlines()
    assert parse_codex_events(lines) is None
    fake = tmp_path / 'fake_codex.sh'
    fake.write_text('#!/bin/sh\ncat ' + str(FIX / 'codex_no_usage.jsonl') + '\n')
    fake.chmod(0o755)
    result = harness.run(agent='codex', brief_path=_brief(tmp_path), out=tmp_path / 'out', command=[str(fake)])
    assert result['costUsd'] is None
    assert result['outcome'] == 'error'


def test_codex_gets_its_key_and_no_stdin(tmp_path, monkeypatch):
    monkeypatch.setenv('OPENAI_API_KEY', 'sk-test')
    monkeypatch.delenv('CODEX_API_KEY', raising=False)
    fake = tmp_path / 'fake_codex.sh'  # usage only when the key arrived as CODEX_API_KEY and stdin is closed
    fake.write_text('#!/bin/sh\n[ "$CODEX_API_KEY" = sk-test ] && [ -z "$(cat)" ] && echo \'{"type":"turn.completed",'
                    '"usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}\'\n')
    fake.chmod(0o755)
    result = harness.run(agent='codex', brief_path=_brief(tmp_path), out=tmp_path / 'out', command=[str(fake)])
    assert result['turns'] == 1


def test_model_is_pinned_on_the_command():
    assert harness.agent_command('codex', 'p', None, 'gpt-6.1-sol')[-3:] == ['-m', 'gpt-6.1-sol', 'p']
    assert harness.agent_command('claude', 'p', None, 'claude-opus-5-5')[-2:] == ['--model', 'claude-opus-5-5']


def test_cost_uses_price_table():
    u = Usage(input=1_000_000, cached_input=0, cache_write=0, output=0, turns=1)
    assert cost_usd(u, PRICES, 'm') == PRICES['m']['input']
    assert cost_usd(u, {'m': {**PRICES['m'], 'input': 9.0}}, 'm') == 9.0
    assert cost_usd(u, PRICES, 'unknown-model') is None


def test_run_times_out_and_records(tmp_path):
    start = time.monotonic()
    result = harness.run(agent='claude', brief_path=_brief(tmp_path), out=tmp_path / 'out',
                         command=['sleep', '30'], timeout=1)
    assert time.monotonic() - start < 5
    assert result['outcome'] == 'timeout'
    assert json.loads((tmp_path / 'out' / 'result.json').read_text())['outcome'] == 'timeout'


def test_no_glb_is_no_output(tmp_path):
    fake = tmp_path / 'fake_claude.sh'
    fake.write_text('#!/bin/sh\ncat ' + str(FIX / 'claude_result.json') + '\n')
    fake.chmod(0o755)
    result = harness.run(agent='claude', brief_path=_brief(tmp_path), out=tmp_path / 'out', command=[str(fake)])
    assert result['outcome'] == 'no_output'
    assert result['checker'] == {'ran': False}
    assert result['costUsd'] == 3.7125


def _brief(tmp_path):
    p = tmp_path / 'brief.md'
    p.write_text('kind: wearable\ncategory: hat\n\nA test hat.\n')
    return p
