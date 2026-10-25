#!/usr/bin/env bash
# The worker image's entrypoint. Locks outbound traffic to the allowlisting proxy, then runs the given command, or
# the worker. Fails closed: if the firewall can't be set (no NET_ADMIN), nothing runs.
set -euo pipefail

filter=/etc/tinyproxy/filter
{
  sed -e 's/#.*//' -e 's/[[:space:]]//g' /opt/allowlist.txt
  if [ -n "${VLM_API_URL:-}" ]; then echo "$VLM_API_URL" | sed -E 's#^[a-z]+://##; s#[:/].*$##'; fi
} | grep -v '^$' | sort -u | sed -e 's/\./\\./g' -e 's/^/^/' -e 's/$/$/' > "$filter"

mkdir -p /var/log/tinyproxy /run/tinyproxy
chown tinyproxy:tinyproxy /var/log/tinyproxy /run/tinyproxy
tinyproxy -c /opt/tinyproxy.conf

for ipt in iptables ip6tables; do
  $ipt -F OUTPUT
  $ipt -A OUTPUT -o lo -j ACCEPT
  $ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  $ipt -A OUTPUT -m owner --uid-owner tinyproxy -j ACCEPT
  $ipt -A OUTPUT -j REJECT
done

for _ in $(seq 50); do
  (exec 3<>/dev/tcp/127.0.0.1/8888) 2>/dev/null && break
  sleep 0.1
done

export HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 NO_PROXY=localhost,127.0.0.1
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY no_proxy=$NO_PROXY
if [ $# -gt 0 ]; then exec "$@"; fi
exec python3 -m studio_worker
