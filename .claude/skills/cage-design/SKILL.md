---
name: cage-design
description: Write or rewrite a module's design for cage (*.cage.mdx next to the code) — from scratch, from a plan, or from existing code (reverse-engineering). Use when asked to design a module, add contracts or invariants, cover NOT_DESIGNED findings, or describe what a module promises.
---

# cage-design

A design is one or more `*.cage.mdx` documents in the module's directory. Prose for people, `ts design` blocks for the compiler. `cage check` verifies the code against it; a reviewer judges the tests against it. Write it for both.

## 1. Decide what deserves a contract

A contract is a promise someone relies on: a service, a repository, an aggregate, an engine, a port to the outside world — a controller that maps an external payload, decides what is acknowledged or skipped, or encodes retry semantics is a port and gets a contract. Everything else goes to `.cageignore` (a `.gitignore`-style file next to the designs; `#` starts a comment, say why):

- helpers and pure utility functions (a line in `.cageignore`, not a contract each)
- DTOs, zod/JSON schemas, ORM tables and entities (`@data` types describe their *shape* when a contract needs them; the schema files themselves are ignored)
- framework wiring: NestJS modules, DI providers, route tables
- controllers and resolvers that only delegate to a service that has a contract; a controller that also composes or orders data on its own is a promise without a checkable home (decorated parameters, inferred shapes): ignore the file, name the promise in "Open questions"

Size: a module has 1–5 contracts, a contract 1–7 methods and 1–7 invariants. More means the contract should be split — one class may implement several contracts (`@implements Lifecycle Reads`), so splitting a contract never requires splitting the code. When the code has 40 exports and you can name 4 promises, that is the design; the other 36 are in `.cageignore` with a one-line reason.

What the harness can check: an exported class (its instance type; a generic one only when every type parameter has a default — it is checked at those defaults), function or const. An abstract class, a class of static methods only (its instance type is empty), an overloaded function, a class with a required type parameter cannot carry `@implements`: describe the concrete thing built from it, or list the file and say why in "Out of scope". A file may be listed in `.cageignore` and still hold tagged declarations: tags in a listed file are read; the list only silences what is not tagged.

`.cageignore` is read like a `.gitignore`: one pattern per line, `#` comments, `name/` a folder at any depth, `*.module.ts` a file name at any depth, `dto/request/x.ts` or `/generated` a path from the module root; no negation (`!`).

From existing code: read the module's public surface and its tests first. The tests say what the code promises today; the design must not promise more than the tests can show, and must not describe implementation details (caches, SQL, retries) as contracts. If the proof lives in tests the configuration does not list (e2e specs, another directory), add their pattern to `tests` in `.cage/config.json` rather than linking invariants to tests that only pin internals; a file the `tests` patterns do not match is read as code. When you may not change the configuration, link what the listed tests do show and write in "Open questions" which invariants are only proven elsewhere, so that the reviewer judges them as such. When the code is looser than the rule (a nullable field the database never leaves null), the design states the truth only if the code is changed with it; otherwise mirror the code and note the gap in "Open questions" — never widen a type in the design to make the check pass.

## 2. Write the document

Use this structure; keep every section, even when short:

```mdx
# <Module>

## Purpose
Two or three sentences: what the module is for and who depends on it.

## Glossary
- **Term** — one sentence. Contract and type names below use these words.

## Business rules
1. Rule in plain words, as a person would state it. The invariants below cite these rules; a rule may become several invariants, on several contracts.
2. ...
Rules no contract carries (a security context, an operational guarantee): stated here, with why no test can show them.
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
- Types of another design: `import type { X } from "../other/other.cage.mdx"` (or a path alias to it). Never from the code, the ORM or a package: describe an independent shape on the boundary instead. An infrastructure parameter that every method takes (a database handle, a request context) is one `@data` type such as `export type DatabaseHandle = unknown`. That works for a contract of methods, because method parameters compare loosely; a contract that is a single call signature (a plain function) compares its parameters strictly, so `unknown` there rejects any implementation that needs a narrower type — prefer a contract of methods for anything that takes infrastructure.
- `@uses A B` (or `@uses A, B`) on a contract names the contracts it calls. `@final` freezes a declaration, `@extendable` allows additions only; use them for public APIs, then run `cage lock`.
- One tag per JSDoc line.
- The compiler compares the implementation's *inferred* types: a literal in the code (`received: true`) is `boolean` to it, so a `@data` type says `boolean`, not `true`. An external event type the code accepts (a webhook envelope) fits a contract when the `@data` type is an envelope whose payload is a union of the shapes the design names.

## 3. Check and tag

1. `cage check --phase design` until the designs have no errors.
2. Tag the code: `/** @implements Things */` above the exported class, function or const that fulfils a contract (`@implements Reads Writes` when one class fulfils several; above the decorators when the class has them); `/** @tests Things */` above the `describe` of its tests; `/** @covers rule-id other-id */` above each test, naming the invariants it demonstrates. `@covers` resolves in the contracts named by `@tests`; a suite or a test that demonstrates several contracts names them all in one tag (`/** @tests Webhook Accounts */` on an e2e suite through a port: each id goes to the contract that has it; an id both have needs a per-test `@tests` naming one). A `@tests` line on a test itself applies to that test only. Every invariant needs at least one test that would fail if the promise were broken; write the missing tests. A skipped or todo test (its own modifier or option, or its suite's) and a test with an empty body or none do not count: an invariant linked only to such tests is `E_TEST_INACTIVE`. A declaration is a plain `it(...)` / `test(...)` with a literal title, or an `it.each(cases)("title", fn)` table counted once under its template title; `it.skipIf` and tests built in a loop are invisible to the harness.
3. `cage check`. Fix what it reports:
   - `E_TYPE_MISMATCH`: the code does not fit the contract — change the code if the contract is right, the contract if the code is right; do not widen types to `any` or `unknown` to pass. A shape the code treats as `Record<string, unknown>` (a webhook payload) must be a `type` alias in the design, not an `interface`: interfaces have no implicit index signature.
   - A tag error in a test file (`E_TAG_FORMAT`, `E_TAG_LOCATION`) sets aside every link that tag was making, and the summary then says how many invariants are "not checked while a rejected tag names their contract": fix tag errors first, the missing tests show after.
   - `E_TEST_MISSING`: an invariant without a test.
   - `NOT_DESIGNED`: an export without `@implements` — a contract, or a line in `.cageignore` with a reason. Never list a file to silence a finding about a real promise.
4. Never delete or soften an invariant or a business rule to make the check pass. If a rule is wrong, say so in "Open questions" and ask.

Run the project's formatter on the documents you wrote if it covers `*.mdx`.

## 4. Report

Say which contracts you wrote, which invariants, which files you put in `.cageignore` and why, and what is in "Open questions". The design is reviewed next (`cage review`); write it so that a stranger can judge it.
