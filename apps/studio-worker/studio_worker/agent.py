"""Runs one prompt through Claude Code or Codex, streaming its progress, and charges it its share of the session.

Each agent runs as the unprivileged `agent` user in its own process group, with only its own key: the group is
killed at the prompt's timeout, or once Claude's running cost passes the prompt's ceiling (Codex reports usage only
at the end of a turn, so time alone caps it).
"""
import json
import os
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from .config import AGENT_USER, DESIGN

PRICES = Path(__file__).parent / 'prices.json'
CLAUDE_PRICE_ROW = 'claude-opus-5-5'  # prices Claude's running cost while it streams
KILL_GRACE_SEC = 5
# Never handed to an agent: the other agent's key, the worker's token, and anything else that looks like a secret
SECRET = re.compile(r'(_API_KEY|_TOKEN|_SECRET)$')


@dataclass
class Usage:
    input: int
    cached_input: int
    cache_write: int
    output: int
    turns: int
    cost_usd: float | None = None


@dataclass
class AgentRun:
    outcome: str  # 'ok' | 'timeout' | 'ceiling' | 'error'
    reply: str
    session: str | None
    usage: Usage | None  # this prompt's share only
    session_total: Usage | None
    cost_usd: float | None
    wall_sec: float
    error: str | None


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


def parse_codex_events(events: list[dict]) -> Usage | None:
    """The usage on the last turn.completed event, which is the session's running total; None when there is none.

    Codex's input_tokens includes its cached and cache-write tokens, and output_tokens its reasoning tokens."""
    turns = [e for e in events if e.get('type') == 'turn.completed' and e.get('usage')]
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
                 + per_m(usage.cache_write, p['cacheWrite']) + per_m(usage.output, p['output']), 6)


def prices() -> dict:
    return json.loads(PRICES.read_text())['models']


def agent_env(agent: str, base: Mapping[str, str], design: Path = DESIGN) -> dict[str, str]:
    env = {k: v for k, v in base.items() if not SECRET.search(k)}
    if agent == 'claude':
        env.update(ANTHROPIC_API_KEY=base.get('ANTHROPIC_API_KEY', ''), CLAUDE_CONFIG_DIR=str(design / '.claude-home'),
                   CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
    else:  # codex exec reads its key from CODEX_API_KEY
        env.update(CODEX_API_KEY=base.get('OPENAI_API_KEY', ''), CODEX_HOME=str(design / '.codex-home'))
    return env


def command_for(agent: str, model: str, prompt: str, session: str | None, max_turns: int) -> list[str]:
    if agent == 'claude':
        return ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', str(max_turns),
                '--model', model, '--dangerously-skip-permissions'] + (['--resume', session] if session else [])
    return ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
            '-m', model] + (['resume', session, prompt] if session else [prompt])


class _Stream:
    """Reads the CLI's JSONL as it arrives: progress lines, the session, the reply and Claude's running cost."""

    def __init__(self, agent: str, on_progress: Callable[[str], None]):
        self.agent, self.on_progress = agent, on_progress
        self.events: list[dict] = []
        self.session = self.reply = None
        self.result: dict | None = None
        self._claude_usage: dict[str, dict] = {}  # message id -> usage; a message streams once per content block

    def feed(self, line: str) -> None:
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(e, dict):
            return
        self.events.append(e)
        (self._claude if self.agent == 'claude' else self._codex)(e)

    def _claude(self, e: dict) -> None:
        self.session = e.get('session_id') or self.session
        if e.get('type') == 'result':
            self.result = e
            self.reply = e.get('result') or self.reply
        if e.get('type') != 'assistant':
            return
        msg = e.get('message') or {}
        if msg.get('usage'):
            self._claude_usage[msg.get('id') or str(len(self._claude_usage))] = msg['usage']
        for block in msg.get('content') or []:
            if block.get('type') == 'text' and block.get('text', '').strip():
                self.reply = block['text']
                self.on_progress(block['text'])
            elif block.get('type') == 'tool_use':
                i = block.get('input') or {}
                what = i.get('command') or ' '.join(filter(None, [block.get('name'), i.get('file_path') or i.get('pattern')]))
                self.on_progress('Running: ' + str(what)[:80])

    def _codex(self, e: dict) -> None:
        if e.get('type') == 'thread.started':
            self.session = e.get('thread_id')
        if e.get('type') != 'item.completed':
            return
        item = e.get('item') or {}
        if item.get('type') == 'agent_message' and item.get('text', '').strip():
            self.reply = item['text']
            self.on_progress(item['text'])
        elif item.get('type') == 'command_execution':
            cmd = re.sub(r"^/bin/(ba)?sh -lc '(.*)'$", r'\2', item.get('command', ''), flags=re.S)
            self.on_progress('Running: ' + cmd[:80])

    def streamed_usage(self) -> Usage:
        """Claude's usage so far, summed over its assistant messages."""
        us = self._claude_usage.values()
        total = lambda k: sum(u.get(k, 0) for u in us)
        return Usage(input=total('input_tokens'), cached_input=total('cache_read_input_tokens'),
                     cache_write=total('cache_creation_input_tokens'), output=total('output_tokens'), turns=len(us))


def run_agent(agent: str, model: str, prompt: str, session: str | None, before: Usage | None, limits: dict,
              on_progress: Callable[[str], None], command: list[str] | None = None,
              as_user: str | None = AGENT_USER, cwd: Path | None = None) -> AgentRun:
    cwd = Path(cwd or DESIGN)
    timeout, ceiling = limits.get('timeoutSec', 1500), limits.get('costCeilingUsd', 3.0)
    table = prices()
    env = agent_env(agent, os.environ, cwd)
    for home in ('.claude-home', '.codex-home'):
        (cwd / home).mkdir(exist_ok=True)
        if as_user and os.geteuid() == 0:
            subprocess.run(['chown', '-R', as_user, str(cwd / home)], check=False)
    cmd = command or command_for(agent, model, prompt, session, limits.get('maxTurns', 80))
    if as_user:
        cmd = ['runuser', '-u', as_user, '--'] + cmd

    stream, stderr = _Stream(agent, on_progress), []
    start = time.monotonic()
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    readers = [threading.Thread(target=lambda: [stream.feed(l) for l in proc.stdout], daemon=True),
               threading.Thread(target=lambda: [stderr.append(l) for l in proc.stderr], daemon=True)]
    for t in readers:
        t.start()
    stopped = None
    while proc.poll() is None:
        if time.monotonic() - start > timeout:
            stopped = 'timeout'
        elif agent == 'claude' and (cost_usd(stream.streamed_usage(), table, CLAUDE_PRICE_ROW) or 0) > ceiling:
            stopped = 'ceiling'
        if stopped:
            _kill_group(proc)
            break
        time.sleep(0.1)
    _kill_group(proc)  # also ends anything the agent left running in the background, such as a Blender
    for t in readers:
        t.join(timeout=KILL_GRACE_SEC)
    wall = round(time.monotonic() - start, 1)

    total = _session_total(agent, stream, table, model)
    usage = _share(total, before) if total else None
    if total is None and agent == 'claude' and stream.streamed_usage().turns:  # stopped before its result line
        usage = stream.streamed_usage()
        usage.cost_usd = cost_usd(usage, table, model) or cost_usd(usage, table, CLAUDE_PRICE_ROW)
        total = _add(before, usage) if before else usage
    failed = proc.returncode not in (0, None) or bool((stream.result or {}).get('is_error')) or \
        any(e.get('type') == 'turn.failed' for e in stream.events)
    outcome = stopped or ('error' if failed or total is None else 'ok')
    error = None
    if outcome == 'error':
        error = (''.join(stderr) or (stream.result or {}).get('result') or 'the agent reported no usage')[-2000:]
    elif stopped:
        error = f'stopped at the {"time limit" if stopped == "timeout" else "cost ceiling"}'
    return AgentRun(outcome=outcome, reply=stream.reply or '', session=stream.session or session, usage=usage,
                    session_total=total, cost_usd=usage.cost_usd if usage else None, wall_sec=wall, error=error)


def _session_total(agent: str, stream: _Stream, table: dict, model: str) -> Usage | None:
    if agent == 'claude':
        if not stream.result:
            return None
        total = parse_claude_result(stream.result)
    else:
        total = parse_codex_events(stream.events)
    if total and total.cost_usd is None:
        total.cost_usd = cost_usd(total, table, model)
    return total


def _share(total: Usage, before: Usage | None) -> Usage:
    """Both CLIs report the whole session's usage, so a resumed prompt is charged the total less `before`."""
    if not before:
        return Usage(**vars(total))
    cost = None if total.cost_usd is None or before.cost_usd is None else round(total.cost_usd - before.cost_usd, 6)
    return Usage(input=total.input - before.input, cached_input=total.cached_input - before.cached_input,
                 cache_write=total.cache_write - before.cache_write, output=total.output - before.output,
                 turns=total.turns, cost_usd=cost)


def _add(a: Usage, b: Usage) -> Usage:
    cost = None if a.cost_usd is None or b.cost_usd is None else round(a.cost_usd + b.cost_usd, 6)
    return Usage(input=a.input + b.input, cached_input=a.cached_input + b.cached_input,
                 cache_write=a.cache_write + b.cache_write, output=a.output + b.output, turns=a.turns + b.turns,
                 cost_usd=cost)


def _kill_group(proc: subprocess.Popen) -> None:
    for sig, wait in ((signal.SIGTERM, KILL_GRACE_SEC), (signal.SIGKILL, KILL_GRACE_SEC)):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            continue
        try:  # the leader is gone; give the rest of the group the same grace before the next signal
            os.killpg(proc.pid, 0)
        except (ProcessLookupError, PermissionError):
            return
