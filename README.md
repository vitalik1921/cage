<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vitalik1921/cage/main/docs/logo-dark.png">
    <img src="https://raw.githubusercontent.com/vitalik1921/cage/main/docs/logo.png" alt="cage" width="260">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cage-ts"><img src="https://img.shields.io/npm/v/cage-ts" alt="npm"></a>
  <a href="https://github.com/vitalik1921/cage/actions/workflows/ci.yml"><img src="https://github.com/vitalik1921/cage/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center"><b>Coding agents change code fast, and the spec and the tests quietly fall behind:</b><br>
the spec promises one thing, the code does another, and a test that still passes no longer checks either.</p>

Cage keeps the three in sync — **the spec** (what a TypeScript module promises), **the code** and **the tests** — and tells your coding agent what is out of sync before it hands the work back.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vitalik1921/cage/main/docs/how-it-works-dark.svg">
    <img src="https://raw.githubusercontent.com/vitalik1921/cage/main/docs/how-it-works.svg" alt="The spec declares an interface and a rule; Cage checks that the code fits the interface, that the rule has a linked test, and that the review is up to date; whatever is missing goes back to the agent, which fixes it and checks again." width="900">
  </picture>
</p>

- **The spec** is a Markdown file next to the code (`quota.cage.mdx`): TypeScript interfaces, and the rules they promise, written as plain sentences — `@invariant consume A successful take uses exactly one send.`
- **The code** says which interface it implements (`@implements Quota`); **the tests** say which rules they check (`@covers consume`).
- **Cage checks deterministically** — no model involved, the same answer on every run — that the code fits the interface (the TypeScript compiler decides), that every rule has a linked test that is not skipped, todo or empty, and that the review of those tests is up to date. **It does not run your tests**: whether they pass is your test runner's job, so CI runs both (see [In CI](#in-ci)).
- **The review** is your agent's written verdict that the tests really check the rules: the judgement is the agent's, whether it is still up to date is Cage's. Cage stores it with a hash of the contract, the spec's prose, the code and tests, and their fingerprinted local dependencies. New reviews ignore ordinary code comments and spacing; changes to code, requirements or significant annotations ask for a new review, naming what changed.
- **When the agent says it is done** (the Stop hook of Claude Code or Codex), Cage sends whatever is out of sync back to it. After three tries in one session it lets the agent stop, with the report.

Cage runs locally and makes no model calls: your agent does the judging, your test runner runs the tests. Start with one module — the bundled skills can write its spec from existing code. Node ≥ 24.11, TypeScript 5 or 6.

**What a green `cage check` means**, and what it does not:

| Green means | It does not mean |
| --- | --- |
| Every contract has an implementation the TypeScript compiler accepts in its place | That the implementation behaves as the rules say |
| Every rule (`@invariant`) has a linked test (`@covers`), and at least one of them is active: not `skip`/`todo` (its own or its suite's), not without a callback or with an empty one, not in a file whose import of a project file is broken (a missing file or export) | That the test asserts the rule, or that it passes — Cage reads tests, it never runs them; a test can also be skipped at run time |
| With `review: "require"`, every contract has a recorded verdict for its material as it is now | That the verdict is right: it is a reviewer's attestation, often the coding agent's own |

## What it catches

Real output, on the Quota example from [Start](#start).

**A rule with no test.** The spec promises that a take uses exactly one send; no test is linked to that rule.

```text
E_TEST_MISSING: Quota.consume (src/quota/quota.cage.mdx:20:6)
```

**A test that changed after its review.** The agent “simplified” the test of that rule; it still passes. Cage names the test, and sends the agent back to review it:

```text
W_REVIEW_STALE: Quota (src/quota/quota.cage.mdx:16:18)
  - test "takes exactly one send" (src/quota/quota.test.ts) changed
```

**A frozen interface that changed.** The interface is marked `@final` (frozen), and the agent changes it anyway:

```text
E_LOCK_VIOLATION: Contract "Quota" is `@final` (src/quota/quota.cage.mdx:17:18)
  `take` changed; it was: take(accountId: AccountId): Promise<boolean>;
```

If the agent unfreezes it to get past that, CI compares with the main branch:

```text
$ cage check --base main
E_LOCK_BASE: Contract "Quota" of src/quota is `@final` on main, gone from .cage/lock.json (.cage/lock.json)
```

Every line is a code, the thing and the place; what a code means and what to do about it is one command, `cage codes`.

## How you use it

Two skills come with Cage: **`cage-design`** writes and changes specs, **`cage-review`** judges whether the tests really check the rules and records the verdict. In Claude Code they load when the task matches, or by name: `/cage-design`, `/cage-review` (`/cage:cage-design` with the plugin). Codex finds them in `.agents/skills/`. The prompts below are what you type.

**Bring an existing module under Cage.**

```text
Write the spec for src/modules/accounts from its code and tests.
```

`cage-design` reads the module's public surface and its tests, picks the few contracts worth keeping (services, ports — not helpers or DTOs, which go to `.cageignore`), writes rules no stronger than the tests can show, tags the code and the tests, and runs `cage check` until it is clean. What it could not decide goes under “Open questions” in the spec.

**Plan a new module, spec first.**

```text
Plan a spec for a send quota: each account gets N sends a month; a send is refused when none are left.
```

`cage-design` writes the spec — purpose, glossary, business rules, data, contracts, out of scope, open questions — and checks it with `cage check --phase design`. You read it; then `Implement the spec.` From here the Stop hook holds the agent to it: code that does not fit, or a rule with no test, comes back before the agent may finish.

**Change behaviour through the spec.**

```text
A deleted organization must not come back from a late webhook. Change the spec first, then the code.
```

The agent edits the rule, then the code and its tests. Those edits make the recorded review outdated, so on “done” Cage sends the agent to `cage-review`, which judges the changed rule against the new tests and records the verdict.

**Review a change someone else made.**

```text
Review the last commit in src/modules/accounts: do the tests still check what the spec promises?
```

`cage check` names what changed since the last review — this test, that implementation, this contract — and `cage review` groups outdated contracts sharing a changed part or dependency file and prints ready-to-run commands. Each contract needing review appears in one suggested packet, with its additional changes listed separately. For example:

```text
### cage review Fill UpdateHeadline
- Shared: dependency changed (src/humanize.config.ts) → Fill, UpdateHeadline
- Additional for Fill: implementation fill changed (src/fill.ts:12)
```

Run the suggested command from the project root. Its packet starts with the shared changes and their material, followed by each consumer's rules, tests and previous findings. Shared parts appear once with the union of their source ranges; whole files supersede excerpts. Grouping a dependency file does not mean every contract uses the same lines or has the same review baseline. `cage-review` reads the common material once, checks its effect on each consumer and records separate verdicts against their own fingerprints. JSON reports expose `groups`, including `command` argument arrays, `sharedChanges` with their consumers, and `additionalChanges` per contract.

Markdown packets put a reference dictionary first: `F1` names a full file path, `T1` names a test at its file/line/column with its title, and `S1` identifies a shared change. Invariants refer to test IDs instead of repeating their paths and titles. The source blocks keep their original text and line numbers; the verdict section lists each fingerprint once and gives one schema example for all contracts. These IDs are local to the packet: use the dictionary's **full paths** in recorded `evidence`, since `--record` does not expand IDs. `--format json` keeps full paths and the existing record schema is unchanged.

Experimental: `cage review NameA NameB --files context` adds full design documents, implementation slices, tests of touched invariants with their setup, test helpers and fingerprinted dependency slices. Markdown includes each selected source line once per file; JSON retains the excerpts for each part. It retains full previous findings and suggested changes and names dependency boundaries still outside the packet. This is current source, including unchanged context, and does not run tests. The default remains `--files changed` while review quality and total reading cost are evaluated.

**Keep agreements in CI.** Mark the contracts others rely on `@final` (no changes) or `@extendable` (additions only) and run `cage lock`. In CI, `cage check --base origin/main` fails a branch that changed or unfroze them.

## Cage checks itself

This repository has its own spec, [`src/cage.cage.mdx`](https://github.com/vitalik1921/cage/blob/main/src/cage.cage.mdx): the command line, the configuration loader and the legend of codes as contracts, the rules of this README as their invariants, and the harness's own tests linked to them. CI runs `cage check` on it with the published package, and the Stop hook holds the agent that works on Cage to the same loop as any other project.

## Does it help?

A first evaluation: one module of a production TypeScript service (NestJS, Drizzle, PostgreSQL), Claude Sonnet 5.5 as the agent, two review runs and three implementation runs per variant. These are preliminary signals, not significant results. Method, tools and every number: [docs/evaluation.md](https://github.com/vitalik1921/cage/blob/main/docs/evaluation.md).

The variants: **with Cage** (plugin and spec), **spec only** (the spec file in the repository, no Cage), and **no spec**.

**Review.** We planted eight problems that keep every test green — weakened tests, bugs the tests cannot see, spec and code drifting apart — as “the last commit by another agent”, then asked an agent to review the module.

| | With Cage | Spec only | No spec |
| --- | --- | --- | --- |
| Planted problems the reviewer found | **100%** (16/16) | 88% (14/16) | 79% (11/14) |
| — of them weakened or disabled tests | **100%** (8/8) | 75% (6/8) | 63% (5/8) |
| False alarms by the reviewer on a clean copy | 0% (0/16) | 0% (0/16) | 0% (0/14) |
| Cost of a review | +39% | baseline | −16% |

Denominators are problems × runs: 8 problems × 2 runs. Without a spec the problem “spec drifted from the code” cannot exist, so 7 × 2.

The difference from spec only came from one problem: an e2e test that had quietly stopped checking an update was reported in 2/2 reviews with Cage and in 0/4 without it. `cage check` had flagged that test as changed since its last review, and the reviewer went to it.

`cage check` on its own — no model calls or token cost — localizes the changes that need review: for every planted problem (8/8) it named the changed test, code or spec. It does not judge them: on the clean copy it flagged the harmless edits the same way.

**Implementing changes.** Three tickets with traps, checked afterwards by hidden behavioural tests against a real database:

| | With Cage | Spec only | No spec |
| --- | --- | --- | --- |
| Runs that passed every hidden test | 89% (8/9) | 100% (9/9) | 100% (9/9) |
| Mutation score of the code the agent changed (share of deliberately broken versions the tests catch), mean over runs | 66% | 66% | 48% |
| Cost of a task | +35% | baseline | −35% |

What the data supports: Cage helped the reviewer notice a specific weakening of a test. This pilot showed no gain in the correctness of implementations, at about a third more cost. The tests were stronger wherever the spec was in the repository, with or without Cage.

## Start

Published on npm as [`cage-ts`](https://www.npmjs.com/package/cage-ts); the command is `cage`.

```sh
npm i -D cage-ts
npx cage init            # .cage/config.json + the Stop hook; asks: claude, codex, both or none
npx cage init --agent claude   # the same without the question (CI, scripts): --agent codex, --agent none
```

In Claude Code you may use the plugin instead of the hook and skills that `init` writes into the repository: it brings the rules, the two skills and the Stop hook, and gates every project that has a `.cage/config.json`.

```text
npx cage-ts init --agent none        # the configuration only
/plugin marketplace add vitalik1921/cage
/plugin install cage@cage
```

Write a spec for a module in a `*.cage.mdx` file next to its code — or ask your agent to, with the [`cage-design`](https://github.com/vitalik1921/cage/blob/main/plugin/skills/cage-design/SKILL.md) skill, from a plan or from the existing code:

````mdx
# Quota

Each account gets a number of sends. The quota is checked before every send.

```ts design
/**
 * @data
 * @description Account identifier.
 */
export type AccountId = string;

/**
 * @contract
 * @description Keeps the remaining sends of each account.
 */
export interface Quota {
  /**
   * @description Takes one send from the account's quota.
   * @invariant empty An empty quota refuses.
   * @invariant consume A successful take uses exactly one send.
   */
  take(accountId: AccountId): Promise<boolean>;
}
```
````

`@contract` marks an interface the code must implement, `@invariant` a rule it promises (an id, then a sentence), `@data` a type it uses. Prose outside the `ts design` blocks is for people.

Tag the implementation and the tests:

```ts
/** @implements Quota */
export class MemoryQuota { … }
```

```ts
/** @tests Quota */
describe("MemoryQuota", () => {
  /** @covers empty */
  it("refuses when nothing is left", …);
  /** @covers consume */
  it("takes exactly one send", …);
});
```

Run `npx cage check`. It reports, with file and line, every contract with no implementation, every implementation that does not fit its contract, every rule with no linked test, every outdated review, and every exported class or function of the module the spec does not mention.

## Commands

| Command | What it does |
| --- | --- |
| `cage init` | First configuration, the Stop hook, and two skills for the agent (`cage-design`, `cage-review`). Run once. |
| `cage check` | Everything: designs, implementations, test links, locks, coverage, reviews. Exit 1 on a violation. |
| `cage check --phase design` | Specs only — while you write them. |
| `cage review` | Suggested review groups and commands, shared and additional changes, and the rules they touch. Missing reviews get individual commands. `--all` also lists current contracts. |
| `cage review <Name…>` | One packet for the named contracts: rules, tests, code, previous findings and changed source ranges, with shared parts included once. `--files all` for whole files, `--files none` for references only. The verdict template keeps a separate entry per contract. |
| `cage review --record <file>` | Saves the reviewer's verdict in `.cage/review.json`. From then on `check` wants an up-to-date one for every contract. |
| `cage review --accept` | Takes the current spec, code and tests of every unreviewed contract as accepted, without a verdict: `check` asks for a review only when they change, and counts them apart from reviewed ones. For a person adopting Cage on an existing project; `--all` includes the reviewed contracts too. |
| `cage lock` | Freezes the contracts marked `@final` (no changes) or `@extendable` (additions only); `check` refuses other changes. |
| `cage gate` | `check` for the agent's Stop hook: only errors go back to the agent; reviews block only under `review: "require"`. `init` wires it up. |
| `cage codes` | What every diagnostic code means and what to do about it. A diagnostic line itself names only the thing and the place. |

`--root <dir>` for a project inside a monorepo; `--format json` for machines (`check`, `lock`, `init`, `review --record` and `review --accept` print `text` by default, the `review` packet `markdown`). In CI, `cage check --base origin/main` also refuses a lock that was lifted on the branch. `check` and `gate` show the 50 diagnostics that matter most and count the rest by code, so that a long report does not drown an agent: `--max-diagnostics <n|all>`, or `maxDiagnostics` in the configuration.

## The loop with an agent

1. The agent changes the spec, the code or a test. When it says it is done, the Stop hook runs `cage gate`.
2. Only errors come back to the agent: a rule with no test, code that does not fit, or a missing, outdated or weak review under `review: "require"`. Warnings remain in `cage check`. After three returns in a session the gate lets the agent stop and leaves the report of blockers, so that a check it cannot fix does not hold the session forever.
3. For a review: the agent runs `cage review`, then the suggested `cage review NameA NameB` commands. Connected shared changes form one packet so a consumer appears only once; missing or unknown reviews stay separate. It reads common material once, judges the touched rules of each contract afresh, confirms or revises previous findings on the others, and records the group's verdicts together with `cage review --record`. Additional changes remain visible for each contract. Cage checks that each verdict is complete and is for its contract's current material; the judgement itself is the reviewer's, which may be the same agent. The verdict is tied to a fingerprint of the contract, the prose of its module's spec, its implementations and the tests linked to it — each with the code of its own file it calls and its suite's setup — and their fingerprinted local dependencies, followed a few levels deep (`reviewDependencies`). Where the bounds stop, Cage says so instead of staying silent.
4. `cage check` is clean; the agent stops.

The rules the agent needs are in the `CLAUDE.md` / `AGENTS.md` section that `init` adds (or in the plugin), and in the two skills: `cage-design` — what deserves a contract and what goes to `.cageignore`, and the spec's structure (purpose, glossary, business rules, data, contracts, out of scope, open questions); `cage-review` — how to judge the tests against the rules and record the verdict.

New review fingerprints (`sha256:code-v2:…`) exclude ordinary comments and spacing in implementations, tests, setup and dependencies, including dependencies kept whole. Packets still show the original source. Cage tags, annotated comments and tooling directives remain material; line-sensitive suppressions retain line layout. Literal contents and syntax affected by a newline remain significant. Contract declarations and the spec's prose are still hashed as text, and code with parse errors conservatively keeps its text fingerprint.

Static reads such as `CEILINGS.mouseMoveMs` or `CEILINGS["mouseMoveMs"]` fingerprint that property and its referenced helpers in eligible dependency objects. Independent sibling fields and methods do not invalidate the review. Explicit sibling calls are followed; dynamic keys, escaped or mutated objects, nested or captured mutable state, `this`, getters, spreads, classes and uncertain initialization retain broader scope. Packets keep the full declaration for context. The existing dependency depth and file limits still apply.

Existing `code-v1` fingerprints keep their declaration-level scope; unversioned fingerprints (`sha256:…`) keep their previous source-text rules: upgrading alone does not invalidate or rewrite them. Comment edits can still stale unversioned records until a new verdict is recorded. There is no automatic acceptance or migration.

## Configuration

`.cage/config.json`, written by `init`; every field has a default.

```json
{
  "version": 1,
  "designs": ["src/**/*.cage.mdx"],
  "implementations": ["src/**/*.ts"],
  "tests": ["src/**/*.test.ts", "tests/**/*.test.ts"],
  "testAdapter": "node:test",
  "review": "warn",
  "coverage": "warn",
  "maxDiagnostics": 50
}
```

- `testAdapter`: `node:test` or `vitest`.
- `review`: a contract without an up-to-date review is a warning (`warn`), an error (`require`) or nothing (`off`). The Stop hook blocks on missing, outdated or weak reviews only under `require`; under `warn` they remain visible in `cage check`.
- `coverage`: exported code of a module with a spec but without `@implements` is a warning, an error, or not looked at. Standalone scalar constants such as `const LIMIT = 300` need no contract. A `.cageignore` next to the spec lists files that need none.
- `maxDiagnostics`: how many diagnostics `check` and `gate` show at most (`50`, or `"all"`); errors come before warnings, missing or outdated reviews before the rest, and what is left out is counted by code. The exit code and the summary are of everything found.
- `reviewDependencies` (`{ "depth": 3, "maxFiles": 40, "exclude": [] }` by default): how far a review's fingerprint follows local imports from the implementation and test files. Type-only imports, `node_modules`, files outside the project, declaration files and `exclude` patterns are not followed. Files beyond the bounds are not fingerprinted and do not produce diagnostics, regardless of review policy. An e2e spec that boots the whole application (a NestJS `AppModule`) reaches every file: exclude that entry point, e.g. `"exclude": ["src/app.module.ts"]`, and the fingerprint keeps to what the contract's code imports.

Commit `.cage/` (config, frozen contracts, reviews) and `.cageignore` with the specs.

## In CI

Cage does not run tests, so a CI job runs both: your tests, then `cage check` with the strict policies. In `.cage/config.json` set `"review": "require"` and `"coverage": "require"`, pin `cage-ts` in `devDependencies`, and add a job like this (GitHub Actions):

```yaml
name: check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0              # cage check --base needs the base branch
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm test                 # your runner: the only step that executes tests
      - run: npx cage check --base origin/${{ github.base_ref || 'main' }}
```

`cage check` exits 1 on any violation and 2 on a configuration or environment problem. Use `cage check`, not `cage gate`, in CI: the gate lets an agent stop after three attempts. Tests skipped at run time (a condition, an environment) are only visible to the runner: make it fail on them if that matters to you.

## More

- Tags, rules and diagnostics in detail: [docs/reference.md](https://github.com/vitalik1921/cage/blob/main/docs/reference.md).
- How the numbers above were measured: [docs/evaluation.md](https://github.com/vitalik1921/cage/blob/main/docs/evaluation.md).
- Development: `npm test`, `npm run verify`, `npm run smoke`.

MIT.
