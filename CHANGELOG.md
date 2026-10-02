# Changelog

## 0.2.4

- README: a diagram of how Cage works (light and dark), plain terms on the first screen (spec, rule, linked test, outdated review, frozen contract), Cage's checks stated as deterministic with the review's judgement left to the agent, and a "How you use it" section with five scenarios and the prompts for the bundled skills.

## 0.2.3

- README: the evaluation in full and with its counts (n/N), including where Cage did not help and what it costs; `cage check` described as localizing changes that need review, not as finding defects; "every declared invariant", "no test is linked".

## 0.2.2

- README: the measured results where Cage helps — review and drift, and test strength with a design; the full results stay in `docs/evaluation.md`.

## 0.2.1

- README: what Cage checks before an agent says "done", real output of the three catches, and the measured results; `docs/evaluation.md` describes how they were measured.

## 0.2.0

- A Claude Code plugin (`plugin/`, marketplace `vitalik1921/cage`): the rules at session start, the `cage-design` and `cage-review` skills, and a Stop hook that runs `cage gate` for every project of the repository with a `.cage/config.json`. It uses the project's own install, else `npx cage-ts@<its version>`. `init` takes the rules and skills from the same directory.
- The gate counts blocks per session and project, so that the projects of a monorepo do not share one count.
- The agent rules warn against a bare `npx cage`: an unrelated npm package has that name.
- `cage gate` blocks on a weak finding only under `"review": "require"`. A missing or stale review still blocks at any level: a change needs a fresh verdict. Before, a project with recorded weak findings could not let an agent stop under `"review": "warn"` until they were all fixed, whatever the agent's task.

## 0.1.1

What the first design written with the published package, and its review, showed.

- `cage gate` lets the agent stop when the project has no `*.cage.mdx` design yet: right after `cage init` there is nothing to hold it to. Before, the Stop hook blocked three times with `E_NO_DESIGNS`.
- `cage init` says where the hook files went when the project is not the repository root.
- `E_NO_DESIGNS` names the `designs` patterns that matched nothing and where a design lives.
- The summary of `check` says how many invariants are "not checked while a rejected tag names their contract", instead of silently showing fewer errors until the tag is fixed (`counts.uncheckedInvariants` in JSON).
- `@tests A B` names several contracts for a suite or a test: each `@covers` id goes to the one named contract that has it, an id two of them share is `E_REFERENCE_AMBIGUOUS`. An e2e test through a port can now be the proof of the service's invariant too; two agents asked for this on their first design.
- `cage gate` sweeps block counters older than a day from the temporary directory; sessions that ended while blocked no longer leave a file each.
- `cage review --record` counts assessments over the invariants only and prints the contract-level findings as notes; the next packet of the contract repeats them ("Notes of the previous review"). Before, three notes read as "3 adequate" on a contract whose five invariants were all weak.
- The packet's "Not loaded" list no longer follows what helpers import (an application module imports everything) and no longer names files another packet of the same report holds.
- "Used outside the module" names the contract's members the file calls, where the syntax shows them; `REVIEW_STALE` repeats them.
- The packet's instruction says what the `cage-review` skill says: a boundary the types allow counts; what only a real database shows is weak even with the clause asserted; evidence may cite a file outside the packet.
- Skill `cage-design`: how `@tests` and `@covers` resolve; a payload shape against `Record<string, unknown>` is a `type`, not an `interface`; fix tag errors first.

## 0.1.0

First public version. `cage init` (configuration, Stop hook, the `cage-design` and `cage-review` skills), `check`, `lock`, `review` (with `--record`) and `gate`; designs as `*.cage.mdx` documents next to the code, nothing generated on disk; adapters for `node:test` and Vitest; locks (`@final`, `@extendable`) with `--base` comparison; design coverage with `.cageignore`; recorded reviews as a second gate; a Stop-hook example for Claude Code.
