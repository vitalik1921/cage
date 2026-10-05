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
