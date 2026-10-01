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

Cage connects a module's design to its TypeScript implementation, its tests and a recorded review — and feeds whatever is missing back to your coding agent.

You describe the module's interfaces and behavioural rules in a Markdown file next to the code. Cage checks that:

- **The implementation fits the contract.** Checked by the TypeScript compiler.
- **Every declared invariant has a linked test.** A missing link is a diagnostic with file and line.
- **The review is current.** A change to the contract, its implementation or a linked test invalidates the recorded verdict, and Cage names what changed.

As a Stop hook, Cage returns the violations to the agent so that it deals with them before it finishes.

Start with one module. The bundled agent skills draft its design from a plan or from existing code, tag the implementation and the tests, and guide the review.

Cage runs locally and makes no model calls: your agent judges the behaviour, your test runner runs the tests. Node ≥ 24.11, TypeScript 5 or 6.

## What it catches

Real output, on the Quota example from [Start](#start).

**An invariant without a test.** The design promises that a take uses exactly one send; no test is linked to it.

```text
src/quota/quota.cage.mdx:20:6: error E_TEST_MISSING: Invariant Quota: consume has no linked test declaration.
```

**A test that changed after its review.** The agent “simplified” the test of that invariant; it still passes. Cage names the test, and the Stop hook sends the agent back to review it:

```text
src/quota/quota.cage.mdx:16:18: warning W_REVIEW_STALE: The recorded review of contract "Quota" is for other material;
  since then: test "takes exactly one send" (src/quota/quota.test.ts) changed. Review it again.
```

**A changed agreement.** The contract is marked `@final`, and the agent changes it anyway:

```text
src/quota/quota.cage.mdx:17:18: error E_LOCK_VIOLATION: Contract "Quota" is `@final`: it must not change.
  `take` changed; it was: take(accountId: AccountId): Promise<boolean>;
```

If the agent lifts the lock to get past it, CI compares with the main branch:

```text
$ cage check --base main
.cage/lock.json: error E_LOCK_BASE: Contract "Quota" of src/quota is locked as `@final` on main,
  but its entry is gone from .cage/lock.json. A lock that main has is not lifted here.
```

## Does it help?

A first evaluation: one module of a production TypeScript service (NestJS, Drizzle, PostgreSQL), Claude Sonnet 5.5 as the agent, two review runs and three implementation runs per variant. These are preliminary signals, not significant results. Method, tools and every number: [docs/evaluation.md](https://github.com/vitalik1921/cage/blob/main/docs/evaluation.md).

The variants: **with Cage** (plugin and design), **design only** (the design document in the repository, no Cage), and **no design**.

**Review.** Eight defects that keep every test green were seeded into the module as “the last commit by another agent”; an agent then reviewed the module.

| | With Cage | Design only | No design |
| --- | --- | --- | --- |
| Seeded defects the reviewer reported | **100%** (16/16) | 88% (14/16) | 79% (11/14) |
| — of them crooked or disabled tests | **100%** (8/8) | 75% (6/8) | 63% (5/8) |
| False alarms by the reviewer on a clean copy | 0% (0/16) | 0% (0/16) | 0% (0/14) |
| Cost of a review | +39% | baseline | −16% |

Denominators are defects × runs: 8 defects × 2 runs. Without a design the defect “design drifted from the code” cannot exist, so 7 × 2.

The difference from design only came from one defect: an e2e test that had quietly stopped checking an update was reported in 2/2 reviews with Cage and in 0/4 without it. `cage check` had flagged that test as changed since its last review, and the reviewer went to it.

`cage check` on its own — no model calls or token cost — localizes the changes that need review: for every seeded defect (8/8) it named the changed test, implementation or contract. It does not judge them: on the clean copy it flagged the harmless edits the same way.

**Implementing changes.** Three tickets with traps, checked afterwards by hidden behavioural tests against a real database:

| | With Cage | Design only | No design |
| --- | --- | --- | --- |
| Runs that passed every hidden test | 89% (8/9) | 100% (9/9) | 100% (9/9) |
| Mutation score of the code the agent changed, mean over runs | 66% | 66% | 48% |
| Cost of a task | +35% | baseline | −35% |

What the data supports: Cage helped the reviewer notice a specific weakening of a test. This pilot showed no gain in the correctness of implementations, at about a third more cost. The tests were stronger wherever the design was in the repository, with or without Cage.

## Start

Published on npm as [`cage-ts`](https://www.npmjs.com/package/cage-ts); the command is `cage`.

```sh
npm i -D cage-ts
npx cage init            # .cage/config.json + Stop hook for Claude Code (--agent codex, --agent none)
```

In Claude Code you may use the plugin instead of the hook and skills that `init` writes into the repository: it brings the rules, the two skills and the Stop hook, and gates every project that has a `.cage/config.json`.

```text
npx cage-ts init --agent none        # the configuration only
/plugin marketplace add vitalik1921/cage
/plugin install cage@cage
```

Describe a module in a `*.cage.mdx` file next to its code — or ask your agent to, with the [`cage-design`](https://github.com/vitalik1921/cage/blob/main/plugin/skills/cage-design/SKILL.md) skill, from a plan or from the existing code:

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

Run `npx cage check`. It reports, with file and line, every contract without an implementation, every implementation the compiler does not accept in the contract's place, every invariant without a linked test, every stale review, and every exported thing in the module the design does not cover.

## Commands

| Command | What it does |
| --- | --- |
| `cage init` | First configuration, the Stop hook, and two skills for the agent (`cage-design`, `cage-review`). Run once. |
| `cage check` | Everything: designs, implementations, test links, locks, coverage, reviews. Exit 1 on a violation. |
| `cage check --phase design` | Designs only — while you write them. |
| `cage review` | The material of every contract that needs a review, with the instruction and the verdict format. |
| `cage review --record <file>` | Records a verdict in `.cage/review.json`. `check` then requires one for every contract, fresh. |
| `cage lock` | Records the contracts marked `@final` / `@extendable`; `check` refuses changes to them. |
| `cage gate` | `check` as a Stop hook: errors and missing or stale reviews go back to the agent. `init` wires it up. |

`--root <dir>` for a project inside a monorepo; `--format json` for machines. In CI, `cage check --base origin/main` also refuses a lock that was lifted on the branch.

## The loop with an agent

1. The agent changes a design, an implementation or a test. Before it stops, the hook runs `cage gate`.
2. Whatever fails comes back to the agent: a missing test, a mismatch, a stale review. After three returns in a session the gate lets the agent stop and leaves the report, so that a check it cannot fix does not hold the session forever.
3. For a review: the agent runs `cage review`, reads the material, judges each invariant, and records the verdict with `cage review --record`. Cage checks that the verdict is complete and is for the material as it is now; the judgement itself is the reviewer's, which may be the same agent. The verdict is tied to a fingerprint of the contract, its implementations and the tests linked to it: change any of those and it is stale again; change something else in those files and it is not.
4. `cage check` is clean; the agent stops.

The rules the agent needs are in the `CLAUDE.md` / `AGENTS.md` section that `init` adds (or in the plugin), and in the two skills: `cage-design` — what deserves a contract and what goes to `.cageignore`, and the document's structure (purpose, glossary, business rules, data, contracts, out of scope, open questions); `cage-review` — how to judge the tests against the invariants and record the verdict.

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
  "coverage": "warn"
}
```

- `testAdapter`: `node:test` or `vitest`.
- `review`: a contract without a fresh recorded review is a warning (`warn`), an error (`require`) or nothing (`off`). The Stop hook returns a missing or stale review to the agent either way; a weak finding only under `require`.
- `coverage`: exported code of a designed module without `@implements` is a warning, an error, or not looked at. A `.cageignore` next to the designs lists files that need no design.

Commit `.cage/` (config, locks, reviews) and `.cageignore` with the designs.

## More

- Tags, rules and diagnostics in detail: [docs/reference.md](https://github.com/vitalik1921/cage/blob/main/docs/reference.md).
- How the numbers above were measured: [docs/evaluation.md](https://github.com/vitalik1921/cage/blob/main/docs/evaluation.md).
- Development: `npm test`, `npm run verify`, `npm run smoke`.

MIT.
