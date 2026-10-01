---
name: cage-design
description: Write or rewrite a module's design for cage (*.cage.mdx next to the code) — from scratch, from a plan, or from existing code (reverse-engineering). Use when asked to design a module, add contracts or invariants, cover NOT_DESIGNED findings, or describe what a module promises.
---

# cage-design

A design is one or more `*.cage.mdx` documents in the module's directory. Prose for people, `ts design` blocks for the compiler. `cage check` verifies the code against it; a reviewer judges the tests against it. Write it for both.

## 1. Decide what deserves a contract

A contract is a promise someone relies on: a service, a repository, an aggregate, a port to the outside world, an engine. Everything else goes to `.cageignore` (a `.gitignore`-style file next to the designs; `#` starts a comment, say why):

- helpers and pure utility functions (a line in `.cageignore`, not a contract each)
- DTOs, zod/JSON schemas, ORM tables and entities (`@data` types describe their *shape* when a contract needs them; the schema files themselves are ignored)
- framework wiring: NestJS modules, DI providers, route tables
- controllers and resolvers that only delegate to a service that has a contract

Size: a module has 1–5 contracts, a contract 1–7 methods and 1–7 invariants. More means the module or the contract should be split. When the code has 40 exports and you can name 4 promises, that is the design; the other 36 are in `.cageignore` with a one-line reason.

From existing code: read the module's public surface and its tests first. The tests say what the code promises today; the design must not promise more than the tests can show, and must not describe implementation details (caches, SQL, retries) as contracts.

## 2. Write the document

Use this structure; keep every section, even when short:

```mdx
# <Module>

## Purpose
Two or three sentences: what the module is for and who depends on it.

## Glossary
- **Term** — one sentence. Contract and type names below use these words.

## Business rules
1. Rule in plain words, as a person would state it. Each rule becomes an invariant below.
2. ...
What the module does not do (non-goals).

## Data
```ts design
/**
 * @data
 * @description What it is, in one sentence.
 */
export interface Thing { ... }
```

## Contracts
```ts design
/**
 * @contract
 * @description What the service promises, in one sentence.
 * @uses OtherContract
 */
export interface Things {
  /**
   * @description What the method does.
   * @invariant rule-id What is promised, observable from outside.
   */
  method(input: Thing): Promise<Result>;
}
```

## Out of scope
What has no design and why (the same files are in `.cageignore`).

## Open questions
Decisions not made yet, for the reviewer and the next agent.
```

Rules of a `ts design` block:

- Only `import type` and exported `interface` / `type`. No classes, functions, values, `enum`, namespaces, `import()` types, `/// <reference>`.
- Every declaration has, directly above it, exactly one marker (`@contract` or `@data`) and a non-empty `@description`.
- `@contract` goes on an interface of methods (or one call signature). No generics, `extends`, optional methods, properties, overloads on a contract. `@data` has no such limits.
- `@invariant <id> <text>` on a method, or on the contract for a rule about the whole interface. `id` is kebab-case and unique in the contract; the text is one observable promise: what a caller sees, under what condition. Not "works correctly"; "returns null for an unknown id and never throws".
- Types of another design: `import type { X } from "../other/other.cage.mdx"` (or a path alias to it). Never from the code, the ORM or a package: describe an independent shape on the boundary instead. An infrastructure parameter that every method takes (a database handle, a request context) is one `@data` type such as `export type DatabaseHandle = unknown`.
- `@uses A B` on a contract names the contracts it calls. `@final` freezes a declaration, `@extendable` allows additions only; use them for public APIs, then run `cage lock`.
- One tag per JSDoc line.

## 3. Check and tag

1. `cage check --phase design` until the designs have no errors.
2. Tag the code: `/** @implements Things */` above the exported class, function or const that fulfils a contract; `/** @tests Things */` above the `describe` of its tests (or on a test itself); `/** @covers rule-id other-id */` above each test, naming the invariants it demonstrates. Every invariant needs at least one test that would fail if the promise were broken; write the missing tests.
3. `cage check`. Fix what it reports:
   - `E_TYPE_MISMATCH`: the code does not fit the contract — change the code if the contract is right, the contract if the code is right; do not widen types to `any` or `unknown` to pass.
   - `E_TEST_MISSING`: an invariant without a test.
   - `NOT_DESIGNED`: an export without `@implements` — a contract, or a line in `.cageignore` with a reason. Never list a file to silence a finding about a real promise.
4. Never delete or soften an invariant or a business rule to make the check pass. If a rule is wrong, say so in "Open questions" and ask.

## 4. Report

Say which contracts you wrote, which invariants, which files you put in `.cageignore` and why, and what is in "Open questions". The design is reviewed next (`cage review`); write it so that a stranger can judge it.
