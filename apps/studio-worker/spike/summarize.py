#!/usr/bin/env python3
"""Prints the spike's agent results as a table: one row per place, agent and brief.

    python3 summarize.py [results-dir]

Reads the harness's result.json copies in spike/results/ (the preview probes there are summarized by hand). A file's
place comes from its name: fly-<size>-<agent>-<brief>.json ran on that Fly machine size, anything else locally.
"""
import json
import sys
from pathlib import Path


def summarize(results: list[dict]) -> list[dict]:
    """Averages each (env, agent, brief) group; cost, time and turns come from the runs that reached `ok` only."""
    groups: dict[tuple, list[dict]] = {}
    for r in results:
        groups.setdefault((r.get('env', 'local'), r['agent'], r['brief']), []).append(r)
    rows = []
    for (env, agent, brief), runs in sorted(groups.items()):
        ok = [r for r in runs if r['outcome'] == 'ok']
        mean = lambda k: round(sum(r[k] for r in ok) / len(ok), 3) if ok and all(r[k] is not None for r in ok) else None
        passed = sum(1 for r in runs if r['checker'].get('pass'))
        rows.append({'env': env, 'agent': agent, 'brief': brief, 'runs': len(runs), 'passed': passed,
                     'pass': round(passed / len(runs), 2), 'costUsd': mean('costUsd'), 'wallSec': mean('wallSec'),
                     'turns': mean('turns')})
    return rows


def load(folder: Path) -> list[dict]:
    out = []
    for f in sorted(folder.glob('*.json')):
        if f.name.startswith('preview-'):
            continue
        r = json.loads(f.read_text())
        r['env'] = f.name.rsplit('-', 2)[0] if f.name.startswith('fly-') else 'local'
        out.append(r)
    return out


def print_table(rows: list[dict]) -> None:
    cols = ['env', 'agent', 'brief', 'runs', 'passed', 'costUsd', 'wallSec', 'turns']
    print(' | '.join(cols))
    for r in rows:
        print(' | '.join(str(r[c]) for c in cols))


if __name__ == '__main__':
    print_table(summarize(load(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / 'results')))
