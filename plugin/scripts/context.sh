#!/bin/sh
# SessionStart hook of the cage plugin: the rules for the agent, and how to run cage here,
# when the repository has cage projects. Its output is added to the session's context.
set -u
. "$(dirname -- "$0")/common.sh"

projects=$(cage_projects)
[ -n "$projects" ] || exit 0

cat "$plugin/rules.md"
printf '\nCage projects in this repository, and the command that runs cage for each (run it from the project directory, or add `--root <project>`):\n'
while IFS= read -r project; do
  printf -- '- %s: `%s`\n' "$project" "$(cage_command "$project")"
done <<PROJECTS
$projects
PROJECTS
