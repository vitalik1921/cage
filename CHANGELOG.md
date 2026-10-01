# Changelog

## Unreleased

- `cage gate` lets the agent stop when the project has no `*.cage.mdx` design yet: right after `cage init` there is nothing to hold it to. Before, the Stop hook blocked three times with `E_NO_DESIGNS`.
- `cage init` says where the hook files went when the project is not the repository root.

## 0.1.0

First public version. `cage init` (configuration, Stop hook, the `cage-design` and `cage-review` skills), `check`, `lock`, `review` (with `--record`) and `gate`; designs as `*.cage.mdx` documents next to the code, nothing generated on disk; adapters for `node:test` and Vitest; locks (`@final`, `@extendable`) with `--base` comparison; design coverage with `.cageignore`; recorded reviews as a second gate; a Stop-hook example for Claude Code.
