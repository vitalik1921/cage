# cage — development notes

`cage` checks TypeScript projects against design documents (`*.cage.mdx`); what it does and the rules it enforces are in `README.md` (start) and `docs/reference.md` (everything). Read the part of the reference that a task touches before changing it.

Work in steps: a concrete task → implementation → `npm run verify` → code review → a person reads the diff → commit.

## Commands

- `npm run typecheck` — tsc for `src/` and `test/`
- `npm test` — `node --test test/*.test.ts`, no build
- `npm run build` — compile to `dist/`
- `npm run verify` — all of the above and a run of the built CLI; run before handing a step over
- `npm run smoke` — `npm pack`, install the tarball into an empty project and run `cage` there; CI and `prepublishOnly` do the same
- `npm run e2e` — build, pack and drive the installed `cage` through hook quoting, links out of the project, review holes, verdict rules and type-only imports in scratch projects outside the repository; evidence in `test/.tmp/e2e-evidence/`
- Release: `npm version <minor|patch>` → `git push --follow-tags` → the `Publish` workflow puts the package on npm (needs the `NPM_TOKEN` secret)
- `node src/cli.ts check --root <project>` — run the CLI without a build
- `npm run cage` — cage checks itself: `src/cage.cage.mdx` is this repository's own spec, checked by the pinned published package (`cage-stable`, an npm alias of `cage-ts`: npm refuses a dependency on the package's own name). CI runs it; the Stop hook in `.claude/settings.json` runs `cage gate` with the same install. Bump `cage-stable` after a release so the gate checks with the current rules.

## Rules

- Never change a requirement or delete a negative fixture to make a check pass.
- Routine technical decisions are yours; record them briefly in `docs/reference.md`, section "Implementation notes".
- The harness never runs the tests of the user's project. The harness's own tests are mandatory.
- A report says what was done, the actual results of the checks, and any deviation. A check that was not run is never called successful.

## Code

- ESM and erasable TypeScript only: Node runs `.ts` without a build. Relative imports are written with `.ts`; the build rewrites them (`rewriteRelativeImportExtensions`).
- The harness loads the target project's TypeScript (`loadTypeScript`); the bundled 6.0.3 is the fallback. So `typescript` is imported as a type only (`import type ts`) and the instance is passed as the `ts` parameter. The code has to work on TS 5.x and 6.x: documented API only, no `as any`. Do not bump the bundled major without a task of its own: TS 7 has no Compiler API.
- `typescript-5` in devDependencies is for the tests only; because of it `node_modules/.bin/tsc` is 5.9, so the scripts call `node_modules/typescript/bin/tsc` explicitly.
- Tests: `node:test` in `test/*.test.ts`. Fixtures live in `test/fixtures/<name>/` and are outside the harness's typecheck. A test that changes a fixture works on a copy (`copyFixture`); small projects for one rule are built by `designProject`. Both write to `test/.tmp/`.
- Expected positions in tests are computed independently of the harness (`find` in `test/helpers.ts`), never copied from its output.
- Diagnostics carry codes (`E_…` errors, `W_…` warnings). Locations: project-relative POSIX path, line and column from 1, columns in UTF-16 units.
- Configuration and environment errors are `E_CONFIG` / `E_ENVIRONMENT` with exit code 2; rule violations exit 1.

<!-- cage:rules -->
## Contract harness

This project keeps its designs in `*.cage.mdx` files, checked by `cage check`. Before you stop, `cage check` must have no errors, and every contract whose design, implementation or linked tests you changed needs a fresh recorded review; the Stop hook (`cage gate`) enforces it and feeds the report back to you. A weak finding blocks only where the project requires adequate reviews (`"review": "require"`); elsewhere it is reported, and it is still work.

- A change to a contract, its module's prose, an implementation, a linked test, or a local file they import makes that contract's review stale. Then: `cage review` lists the contracts in need of a review, with what changed since the recorded review and which invariants it touches; `cage review <Name>` prints one contract's material — for an outdated review the lines that changed and the previous findings, the rest by file and line — with the verdict template at the end; the instruction is the `cage-review` skill. Take one contract at a time, read it, judge each invariant as a stranger would (afresh where its material changed, confirming or revising the previous finding where it did not), write the verdict as JSON to a file, and run `cage review --record <file>`.
- Never lower an assessment to make the check pass, and never remove or soften an invariant for that reason. A `weak` finding is work: fix the test, then review again. `cage review --accept` records material as accepted without a review: that is a person's decision, never a way past the gate; do not run it unless the person asks for it.
- A diagnostic is `CODE: what (file:line:column)`; what a code means and what to do about it is `cage codes`. `cage check` shows the diagnostics that matter most and counts the rest by code (`N more not shown`): fix what is shown and check again; `--max-diagnostics all` shows every one.
- Locks: a contract or data type marked `@final` or `@extendable` must not change as the lock says. Do not edit `.cage/lock.json` by hand.
- `.cage/config.json` is the project's: do not change `review`, `coverage`, `reviewDependencies` or the patterns to make a check pass or a review smaller. `REVIEW_SCOPE_LIMIT` says where the fingerprint stops; that is a setting for a person to revisit, not a finding to fix.
- Run cage with the project's own install (`node_modules/.bin/cage`, `pnpm exec cage`) or as `npx cage-ts`; never a bare `npx cage` where the package does not depend on cage-ts: an unrelated npm package has that name.
- `cage check` reads tests, it never runs them: run the project's tests yourself. An invariant linked only to skipped, todo or empty tests is an error (`E_TEST_INACTIVE`); give it a test that runs.
- Two skills come with cage: `cage-design` (write or rewrite a module's design, also from existing code) and `cage-review` (judge the tests against the invariants and record the verdict). Use them for those tasks.
- Exported code of a designed module that nothing marks `@implements` is reported (`NOT_DESIGNED`): describe its contract in the design, or list the file in the module's `.cageignore` when it needs no design. Whether this blocks you is the project's `"coverage"` setting.
