# Runs inside the locked-down image (see network.sh). One line per check; exits non-zero if any fails.
fail=0
pass() { echo "OK   $1"; }
bad() { echo "FAIL $1"; fail=1; }

runuser -u agent -- curl -fsS --max-time 15 -o /dev/null https://example.com 2>/dev/null \
  && bad "agent reached example.com through the proxy" || pass "agent can't reach example.com"
runuser -u agent -- curl -fsS --max-time 15 --noproxy '*' -o /dev/null https://example.com 2>/dev/null \
  && bad "agent reached example.com around the proxy" || pass "agent can't go around the proxy"
code=$(runuser -u agent -- curl -sS --max-time 15 -o /dev/null -w '%{http_code}' https://api.anthropic.com/v1/models || true)
[ "$code" = 401 ] && pass "agent reaches api.anthropic.com (HTTP $code without a key)" || bad "api.anthropic.com gave '$code'"
curl -fsS --max-time 15 --noproxy '*' -o /dev/null https://example.com 2>/dev/null \
  && bad "root reached example.com around the proxy" || pass "root can't go around the proxy"
getent hosts example.com >/dev/null 2>&1 && runuser -u agent -- getent hosts example.com >/dev/null 2>&1 \
  && echo "INFO agent can resolve DNS names (no data leaves but the query)" || pass "agent can't resolve DNS"

mkdir -p /work/design/out/hat && cp /fixtures/cap/*.glb /work/design/out/hat/ \
  && echo '{"name": "Neon Cap", "category": "hat"}' > /work/design/out/hat/piece.json && chown -R agent /work/design/out
if (cd /work/design && runuser -u agent -- env HTTPS_PROXY="$HTTPS_PROXY" studio-preview out/hat --out /tmp/review); then
  pass "studio-preview renders through the proxy"
else
  bad "studio-preview failed"
fi
runuser -u agent -- sh -c 'echo x > /work/design-state-probe' 2>/dev/null \
  && bad "agent can write beside the design" || pass "agent can't write outside /work/design"
mkdir -p /work/design-state && chmod 700 /work/design-state
runuser -u agent -- ls /work/design-state >/dev/null 2>&1 && bad "agent can read the worker's state" \
  || pass "agent can't read the worker's state"
runuser -u agent -- sh -c 'setsid sleep 300 >/dev/null 2>&1 < /dev/null &'
python3 - <<'PY' && pass "an agent's own-session process is ended with it" || bad "an agent process outlived the run"
import subprocess, sys
from studio_worker.agent import run_agent
run_agent('codex', 'm', 'p', None, None, {'timeoutSec': 5}, lambda t: None,
          command=['sh', '-c', 'setsid sleep 300 & echo {}'], as_user='agent', cwd=__import__('pathlib').Path('/work/design'))
import time
for _ in range(30):  # killed processes take a moment to be reaped
    left = subprocess.run(['pgrep', '-u', 'agent'], capture_output=True, text=True).stdout.split()
    if not left:
        sys.exit(0)
    time.sleep(0.1)
print('left running as agent:', subprocess.run(['ps', '-o', 'pid,stat,cmd', '-u', 'agent'], capture_output=True,
      text=True).stdout)
sys.exit(1)
PY
echo "--- hosts the proxy let through:"
grep -oE 'CONNECT [^ :]+' /var/log/tinyproxy/tinyproxy.log | sort | uniq -c | sort -rn
echo "--- hosts the proxy denied:"
grep -iE 'filtered|denied|refused' /var/log/tinyproxy/tinyproxy.log | grep -oE '"[^"]+"|[a-z0-9.-]+\.[a-z]{2,}' | sort | uniq -c | sort -rn | head -20
exit $fail
