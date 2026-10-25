from summarize import summarize


def _r(agent, brief, outcome, cost, wall, turns, passed, env='local'):
    return {'env': env, 'agent': agent, 'brief': brief, 'outcome': outcome, 'costUsd': cost, 'wallSec': wall,
            'turns': turns, 'checker': {'ran': passed is not None, 'pass': passed}}


def test_summary_table():
    rows = summarize([_r('claude', '01-hat-build.md', 'ok', 1.0, 100.0, 10, True),
                      _r('claude', '01-hat-build.md', 'error', 0.5, 2.0, None, None),
                      _r('codex', '01-hat-build.md', 'ok', 0.2, 50.0, 1, True)])
    claude = next(r for r in rows if r['agent'] == 'claude')
    assert (claude['runs'], claude['passed']) == (2, 1)
    assert claude['costUsd'] == 1.0  # the failed run is left out of the average
    assert (claude['wallSec'], claude['turns'], claude['pass']) == (100.0, 10, 0.5)
    assert len(rows) == 2
