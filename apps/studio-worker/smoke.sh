#!/usr/bin/env bash
# Checks the studio worker image has every tool a studio run needs. One line per tool; exits non-zero if any is missing.
set -u
fail=0
check() { # name, command
  if out=$(bash -c "$2" 2>&1); then echo "OK   $1: $(echo "$out" | head -1)"; else echo "FAIL $1: $(echo "$out" | tail -1)"; fail=1; fi
}
check blender "blender --version 2>/dev/null | grep -E '^Blender 4\.4\.'"
check python "python3 -c 'import numpy, playwright; print(\"numpy\", numpy.__version__)'"
check chrome "google-chrome --version"
check claude "claude --version | grep -F '2.1.310'"
check codex "codex --version | grep -F '0.164.0'"
check skills "test -f /work/design/.claude/skills/creating-dcl-wearables/SKILL.md && test -f /work/design/.agents/skills/creating-dcl-wearables/SKILL.md && echo 'claude + codex'"
check skills-sha "runuser -u agent -- python3 -c 'from studio_worker import config; print(config.skills_sha())' | grep -E '^[0-9a-f]{40}\$'"
check assets "test -r /opt/assets/AvatarShape_A.blend && test -r /opt/assets/AvatarShape_B.blend && echo 'A + B'"
check studio-preview "command -v studio-preview"
check tinyproxy "tinyproxy -v"
check iptables "iptables -V"
exit $fail
