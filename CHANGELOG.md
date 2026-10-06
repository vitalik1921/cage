# Changelog

## Unreleased

## 0.5.0

- Review fingerprints select imported declarations and their helpers in modules with conservatively verified inert initialization. Unrelated declarations no longer stale a review in those modules; uncertain cases retain whole-file tracking. Classes, dependency limits and gate filtering are unchanged.
- Changed review packets show the dependency ranges used by the fingerprint; `--files all` includes fingerprinted dependencies whole. Import retargeting is tracked, and fingerprints and excerpts share source snapshots.
- Existing review records remain readable. The new material can require a fresh review after upgrading; no verdict or acceptance is automatically renewed.

## 0.4.2

- `gate` shows only diagnostics that block the stop. Other warnings, including `W_REVIEW_SCOPE_LIMIT`, remain in `check`; the gate's diagnostic limit, omitted counts and error/warning totals cover only blockers, including when it lets the agent stop after three attempts.

## 0.4.1

- Cage checks itself: `src/cage.cage.mdx` with the command line, the configuration loader and the legend of codes as contracts and the README's rules as invariants, linked to the harness's own tests and reviewed; CI runs `cage check` on the repository with the published package.
- The rules for the agent no longer say that a packet ends with the reviewer's instruction: it ends with the verdict template, and the instruction is the `cage-review` skill's.

## 0.4.0

- **A diagnostic is a code, a thing and a place.** The text report prints `CODE: what (file:line:column)` — `E_TEST_MISSING: Quota.consume (…)`, `W_REVIEW_STALE: Quota (…)` with the changed parts beneath, `E_TYPE_MISMATCH: MemoryQuota does not fit Quota (…, TS1360)` with the compiler's explanation beneath — and nothing else: no severity word (the prefix says it), no sentence about what the code means or what to do. That is `cage codes`, one line per code, and the "Codes" table of the reference. Every message was rewritten this way; the JSON `message` is the same short text. A report of fifty findings is fifty facts.
- **The review packet is facts only.** No instruction (it is the `cage-review` skill's and the reference's; the JSON report keeps `instruction`, `resultFormat` and `resultSchema`), no status legend, no section that says "none": the contract's lines (`fingerprint`, `design`, `review`, `tests`, `check`), `## Changed` with `touches:`, `## Invariants` with the previous finding per invariant, `## Code` with one line per fact that exists, the changed lines or the files, and `## Verdict` with the template and the fingerprints filled in. The index is one line per contract with its codes. The packet of one contract with one changed test is about a third of what it was.

## 0.3.1

- **A diagnostic reads code first.** The text report prints `CODE: severity at file:line:column` and the message on the lines below, indented; a list in a message — the parts that changed since a review, the tests that cannot run, the files past the bounds — is one item a line, and `REVIEW_STALE` names ten parts at most, then counts the rest (`cage review <Name>` lists them all). Before, everything was one line per diagnostic, and a stale review of a contract with forty tests was one line of two thousand characters. JSON is unchanged except that these messages contain line breaks.
- **`REVIEW_SCOPE_LIMIT` is `check`'s to say, not the review's.** The review packet and the index no longer carry it, and the `check` message states where the fingerprint stops without telling anyone to raise `depth` or `maxFiles` or to edit `exclude`: an agent that reads it in a review went to change `.cage/config.json`. The rules for the agent and the `cage-review` skill say that the configuration is the project's. A dependency that cannot be read is still reported in the packet.
- **A file edited while `cage review` runs no longer crashes it.** The material of a review was read from the disk a second time, after the check had found the tests and implementations in it; when a test file changed in between, a test's position pointed past the end of its line and `review` stopped with `internal error: Debug Failure. False expression.` The material is now cut from the very text the check read.

## 0.3.0

- **`cage review` without names is an index, not a dump.** It lists the contracts in need of a review — what changed since the recorded review (`changed`: the part, `changed` / `new` / `gone`, file and line) and which invariants that touches (`touched`) — one line each, no file text; `--all` lists every contract with its status. Before, it exported the material of every such contract whole: on a project with a hundred contracts, a million tokens for a reviewer that reads one contract at a time.
- **`cage review <Name>` carries what changed, the rest by reference.** `--files changed` (the default): for an outdated review, the lines each changed part was taken from, numbered as in the file (`excerpts`), and whole only a changed design or dependency; when there is no review to compare with, everything, as before. `--files all` is the old packet; `--files none` names the files and lines only. Each invariant repeats the previous finding (`prior`) and says whether its material changed (`touched`: a changed or new test covers it, its previous finding's evidence points into the lines of a changed test, it has no linked test any more, or anything but a test changed): the touched ones are judged afresh, the others confirmed or revised, and the verdict still covers every invariant. The instruction, the rules for the agent and the `cage-review` skill say so. A packet of a contract whose `.cage/review.json` is unusable now exits 2 with the `E_CONFIG`, as `check` does.
- **`check` and `gate` show at most 50 diagnostics** — the ones that matter most: configuration and environment errors, then errors, then missing or outdated reviews, then the rest, in the report's order — and count what is left out by code in one line (`7 more not shown (4 W_REVIEW_MISSING, 3 W_NO_INVARIANTS): …`), so that a long report does not drown an agent. The exit code, the counts and the summary are of everything found. `"maxDiagnostics"` in `.cage/config.json` (a whole number or `"all"`; `init` writes 50, which an older `cage-ts` rejects as an unknown field: pin the version that ran `init`) and `--max-diagnostics <n|all>` for one run; the JSON report has `omitted`.
- **`cage review --accept`** takes the material of every contract without a fresh record as accepted without a review: an entry in `.cage/review.json` with the fingerprint, `"accepted": true` and no findings. `check` asks for no review of it until the material changes, then reports the acceptance as outdated and asks for a review; it counts acceptances apart from what a reviewer attested (`counts.acceptedInvariants`, `counts.acceptedContracts`, `review: "accepted"` per invariant, `N contracts accepted without review (M invariants)` in the summary), and the packet's status says that adequacy is not attested. Names and `--all` replace recorded verdicts too; without names a fresh verdict is kept. For a person adopting cage on an existing project; the rules for the agent say not to run it on its own.

## 0.2.6

What the audits of 0.2.5 found: a required review stayed fresh while behaviour changed, and invariants linked only to tests that never run passed.

- **Review fingerprints cover what the reviewed code relies on.** Besides the contract's declaration, the parts are now: the prose of the module's design (`design <file>`, its `ts design` blocks left out); for an implementation or a test, the top-level declarations of its own file it refers to, and for a test its setup — the runner hooks in effect for it, at the file's top level and in its suites, found by their binding to the runner (aliases, namespaces, globals), and its suites' variables; and the local files the implementation and test files import (`dependency <file>`), breadth first within `reviewDependencies` (`depth` 3, `maxFiles` 40, `exclude`). Type-only imports, `node_modules`, files outside the project, declaration files and excluded patterns are not followed; another contract's implementation file is fingerprinted but not followed. What the bounds leave out is `REVIEW_SCOPE_LIMIT` (an error under `"review": "require"`), and the packet lists the fingerprinted files. **Reviews recorded with 0.2.5 or earlier become outdated once**: the next check names the new parts.
- **Inactive tests.** Each test declaration has a status read from its text: `skipped` or `todo` by its own modifier or option or by an enclosing suite's, `empty` without a callback or with an empty one — inline or named in the same file (a function, a `const`, a trivial alias or object property; imported or computed callbacks count as active), else `active`. An invariant linked only to inactive tests is `E_TEST_INACTIVE`; an inactive test is `W_TEST_INACTIVE` for the invariants it shares with an active test, each reported on its own. Structural detection only: it does not prove that an active test asserts anything.
- **The summary line tells four things apart**: linked declarations, active ones, test execution (“not run by cage”) and review attestation. The JSON report adds `counts.activeTestDeclarations`, `counts.activeInvariants`, `counts.executedTests` (always `null`) and `activeTestCount` per invariant.
- **`cage init` asks for the agent.** Without `--agent`, in a terminal, it asks: claude, codex, both or none; there is no default, a blank or unknown answer is asked again, and the end of input cancels (exit 130) with nothing written. Without a terminal it fails with exit 2 and names `--agent claude|codex|none`; before, it set up Claude Code silently. `--agent` works as before.
- **The review packet says what is known, line by line.** A Status block per contract: material collected (not judged), tests active in their text, test results not known (cage does not run them), the check's findings, and the recorded review — none, outdated, or current with its counts as a reviewer's assessment. The JSON adds `recordedReview` per packet and `status` per test declaration. `--record` marks each contract `✓` or `!` and says that a verdict is an assessment, not a test run.
- **Contract-level findings that are not adequate are shown as such.** `cage review --record` accepted a finding about the contract as a whole (`invariant: null`) assessed `weak`, `unrelated` or `insufficient-context` and printed `✓`, and the packet's status said the review was adequate, while `check` reported `REVIEW_WEAK`. They are now counted apart (`contractAssessments` in the record report and in the packet's `recordedReview`), the contract is marked `!`, the note starts with its assessment, and `check` counts them (`counts.weakContracts`, “N contracts found weak as a whole”). Review files written before are read the same way.
- **A test file with a broken import does not count as active.** A tagged test file that imports a project file that is not there, or a name that file does not export, has its declarations `broken-import`: the compiler rejects the file and Node does not load it, so `E_TEST_INACTIVE` / `W_TEST_INACTIVE` apply as for a skipped test. Before, a removed export left the tests “active” and `check` green while `tsc` and `node --test` failed. Only imports are looked at; the rest of a test file is still not type-checked.
- **Security: the hooks `init` writes pass paths as data.** Paths were put into double quotes, so a `$`, a backtick or `$(…)` in a directory name was expanded — run — by the shell of the Stop hook, and an apostrophe broke the Codex TOML. Each path is now a single-quoted shell word, `$CLAUDE_PROJECT_DIR` is the only variable, and the Codex command is a TOML basic string. A hook an earlier version wrote is still recognised for an ordinary path; for a path with such characters it is not (it runs what the path says), so re-running `init` adds the safe gate beside it and warns with `W_GATE_COMMAND` — remove the old one by hand; `init` never deletes a hook.
- **A hook is the gate only when it runs the gate.** `init` used to take any command containing `cage gate` (`echo cage gate …`) for the project's gate and add none. It now parses the command as a shell would and needs an installed `cage`, `gate` and `--root` naming the project, with nothing else a shell would act on; otherwise the gate is added beside the other hooks, none is removed, and a near miss is `W_GATE_COMMAND`.
- **The rules are found by their marker.** `init` skipped CLAUDE.md / AGENTS.md whenever the file mentioned `cage check`. The rules now go in behind `<!-- cage:rules -->`, and a file is taken to have them when it holds that marker or the rules' heading (as earlier versions wrote it).
- **Security: review material stays inside the project.** A file that a symbolic link in the project points to outside it, imported by a test or an implementation, was read into the packet (helpers) and the fingerprint (dependencies): the compiler resolves a relative import to the link's own path, inside the project. Its real path is now checked first, without opening it: a dependency out of the project is a `REVIEW_SCOPE_LIMIT` hole (an error under `"review": "require"`), a helper `W_OUTSIDE_ROOT`; the content is never read or written out.
- **A dependency that cannot be read stops the review.** The packet did not show it (`complete` stayed `true`) and `--record` recorded a fingerprint without it. It is now `E_ENVIRONMENT` in the packet, which is incomplete (exit 2), and `--record` refuses, the review file unchanged.
- **The setup around a test in a block or a loop is part of it.** What plain blocks and loop bodies around a test declare, and the loop headers, are in the test's fingerprint: an edit to them makes the review outdated. Text, not data flow.
- **A verdict says why and on what.** `--record` refuses, with nothing recorded, a finding — about an invariant or the contract as a whole — with a blank reason, or with null or blank evidence unless it is `insufficient-context` (which may have null). This was the documented shape; verdicts files without it that 0.2.5 accepted are refused now, recorded review files are read as before. The packet's `resultSchema` says the same.
- **A value import of a type is a broken import** where imports are kept as written: node:test (Node's type stripping) and `verbatimModuleSyntax`; under Vitest only when the name is used as a value. The value is looked for through aliases and re-exports, named and star: `export type { x }`, `export type * from` and `export type * as ns` pass a name on as a type only, and a value star over them does not bring it back. `import type` and `{ type X }` stay active, CommonJS `export =` modules are not judged.
- The packet's line about diagnostics is called “Structural check”: the recorded review has its own line.
- `--format` errors name the command they are about; an empty `--root` or `--config` is a usage error. The reference lists the formats of `review` (`markdown|json`) and `review --record` (`text|json`).
- README: what a green check means and does not, and a CI recipe that runs the tests and `cage check --base` with `review` and `coverage` required.

## 0.2.5

- README opens with the problem Cage answers: the spec, the code and the tests drifting apart as agents change code.

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
