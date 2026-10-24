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
check claude "claude --version"
check codex "codex --version"
check skills "test -f /work/.claude/skills/creating-dcl-wearables/SKILL.md && test -f /work/.agents/skills/creating-dcl-wearables/SKILL.md && echo 'claude + codex'"
exit $fail
