# Shared by the hooks of the cage plugin. POSIX sh.

repo=${CLAUDE_PROJECT_DIR:-$PWD}
plugin=${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$plugin/.claude-plugin/plugin.json" | head -n 1)

# The cage projects of the repository: every directory that holds .cage/config.json, one per line.
cage_projects() {
  find "$repo" \( -name node_modules -o -name .git -o -name dist -o -name build -o -name coverage \) -prune \
    -o -type f -path '*/.cage/config.json' -print 2>/dev/null |
    sed 's#/\.cage/config\.json$##' | sort
}

# The command that runs cage for a project: $CAGE_BIN when set, the project's own install
# (looked up from the project to the repository root), else the package of this plugin's
# version through npx. Never a bare `npx cage`: an unrelated npm package has that name.
cage_command() {
  if [ -n "${CAGE_BIN:-}" ]; then
    printf '%s\n' "$CAGE_BIN"
    return
  fi
  dir=$1
  while :; do
    if [ -x "$dir/node_modules/.bin/cage" ]; then
      printf '%s\n' "$dir/node_modules/.bin/cage"
      return
    fi
    if [ "$dir" = "$repo" ] || [ "$dir" = / ]; then break; fi
    dir=$(dirname -- "$dir")
  done
  printf '%s\n' "npx --yes cage-ts@$version"
}
