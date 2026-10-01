# cage

[![npm](https://img.shields.io/npm/v/cage-ts)](https://www.npmjs.com/package/cage-ts) [![CI](https://github.com/vitalik1921/cage/actions/workflows/ci.yml/badge.svg)](https://github.com/vitalik1921/cage/actions/workflows/ci.yml)

A gate for agent-written code. You describe a module's design in a Markdown file next to the code — contracts as TypeScript interfaces with invariants in plain words — and `cage check` verifies that the code implements them, that every invariant has a test, and that a substantive review of each contract is on record. As a Stop hook, it does not let an agent finish while any of that fails.

Nothing is executed and nothing is sent anywhere. Node ≥ 24.11, TypeScript 5 or 6.

## Start

Published on npm as [`cage-ts`](https://www.npmjs.com/package/cage-ts); the command is `cage`.

```sh
npm i -D cage-ts
npx cage init            # .cage/config.json + Stop hook for Claude Code (--agent codex, --agent none)
```

Describe a module in a `*.cage.mdx` file next to its code:

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
  it("takes one send", …);
});
```

Run `npx cage check`. It reports, with file and line, every contract without an implementation, every implementation the compiler does not accept in the contract's place, every invariant without a test, and every exported thing in the module the design does not cover.

## Commands

| Command | What it does |
| --- | --- |
| `cage init` | First configuration, the Stop hook, and two skills for the agent (`cage-design`, `cage-review`). Run once. |
| `cage check` | Everything: designs, implementations, test links, locks, coverage, reviews. Exit 1 on a violation. |
| `cage check --phase design` | Designs only — while you write them. |
| `cage review` | The material of every contract that needs a review, with the instruction and the verdict format. |
| `cage review --record <file>` | Records a verdict. `check` then requires one for every contract, fresh. |
| `cage lock` | Records the contracts marked `@final` / `@extendable`; `check` refuses changes to them. |
| `cage gate` | `check` as a Stop hook: errors and review findings block the agent. `init` wires it up. |

`--root <dir>` for a project inside a monorepo; `--format json` for machines. In CI, `cage check --base origin/main` also refuses a lock that was lifted on the branch.

## The loop with an agent

1. The agent changes a design, an implementation or a test. The Stop hook runs `cage gate`.
2. Whatever fails comes back to the agent as feedback: a missing test, a mismatch, a stale review.
3. For a review: the agent runs `cage review`, reads the material, judges each invariant, writes the verdict and records it with `cage review --record`. The verdict is tied to a fingerprint of the contract, its implementations and the tests declared for it: change any of those and it is stale again; change something else in those files and it is not.
4. `cage check` is clean; the agent may stop.

The rules the agent needs are in the `CLAUDE.md` / `AGENTS.md` section that `init` adds, and in two skills it installs (`.claude/skills/` or `.agents/skills/`): `cage-design` — how to write a module's design, from a plan or from existing code, what deserves a contract and what goes to `.cageignore`, the document structure (purpose, glossary, business rules, data, contracts, out of scope, open questions); `cage-review` — how to judge the tests against the invariants and record the verdict. The harness never calls a model itself.

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
- `review`: a contract without a fresh recorded review is a warning (`warn`), an error (`require`) or nothing (`off`). The Stop hook blocks on it either way.
- `coverage`: exported code of a designed module without `@implements` is a warning, an error, or not looked at. A `.cageignore` next to the designs lists files that need no design.

Commit `.cage/` (config, locks, reviews) and `.cageignore` with the designs.

## More

- Tags, rules and diagnostics in detail: [docs/reference.md](https://github.com/vitalik1921/cage/blob/main/docs/reference.md).
- Development: `npm test`, `npm run verify`, `npm run smoke`.

MIT.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/vitalik1921/cage/main/docs/logo-dark.png">
    <img src="https://raw.githubusercontent.com/vitalik1921/cage/main/docs/logo.png" alt="cage" width="120">
  </picture>
</p>
