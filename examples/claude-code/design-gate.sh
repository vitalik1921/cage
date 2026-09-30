#!/bin/sh
# Stop hook for Claude Code: the agent may not finish while `design check` fails.
# Install: copy next to your project and reference it from .claude/settings.json (see settings.json here).
# A failing check is fed back to the agent (exit 2 + stderr); the agent then fixes the code, the
# design or the tests, or reviews: `design review` → write the verdict → `design review --record`.
set -u
input=$(cat)
# Do not loop: a Stop hook that already blocked once lets the agent stop the second time.
case "$input" in *'"stop_hook_active":true'*) exit 0 ;; esac
output=$(design check 2>&1)
status=$?
if [ "$status" -ne 0 ]; then
  printf '%s\n\n`design check` failed (exit %s). Fix what it reports before stopping. For REVIEW_MISSING or REVIEW_STALE: run `design review`, read the material, write the verdict in the format it ends with, and record it with `design review --record <file>`.\n' "$output" "$status" >&2
  exit 2
fi
exit 0
