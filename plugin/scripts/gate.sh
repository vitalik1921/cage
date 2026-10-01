#!/bin/sh
# Stop hook of the cage plugin: `cage gate` for every cage project in the repository.
# Each gate reads the hook's input (session, stop_hook_active) and counts its own blocks;
# when any blocks, its report goes to the agent and the stop is refused.
set -u
. "$(dirname -- "$0")/common.sh"

input=$(cat)
projects=$(cage_projects)
[ -n "$projects" ] || exit 0

status=0
report=$(mktemp "${TMPDIR:-/tmp}/cage-plugin.XXXXXX")
output=$(mktemp "${TMPDIR:-/tmp}/cage-plugin.XXXXXX")
trap 'rm -f "$report" "$output"' EXIT

while IFS= read -r project; do
  command=$(cage_command "$project")
  # $command is word-split on purpose: it may be `npx --yes cage-ts@x` or a CAGE_BIN with arguments.
  printf '%s' "$input" | $command gate --root "$project" 2>"$output"
  code=$?
  if [ "$code" -eq 2 ]; then
    status=2
    { printf 'cage project %s:\n' "$project"; cat "$output"; } >>"$report"
  elif [ "$code" -ne 0 ]; then
    { printf 'cage gate could not run for %s (exit %s):\n' "$project" "$code"; cat "$output"; } >&2
  fi
done <<PROJECTS
$projects
PROJECTS

if [ "$status" -eq 2 ]; then
  cat "$report" >&2
  exit 2
fi
exit 0
