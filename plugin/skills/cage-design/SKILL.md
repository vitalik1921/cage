---
name: cage-design
description: Write or rewrite a module's design for cage (*.cage.mdx next to the code) — from scratch, from a plan, or from existing code (reverse-engineering). Use when asked to design a module, add contracts or invariants, cover NOT_DESIGNED findings, or describe what a module promises.
---

# cage-design

A design is the single source of truth for a module's business rules and deterministic design. Keep it in `*.cage.mdx` next to the code: Gherkin states promises and examples; TypeScript owns types and relations. Cage checks structure and links deterministically; a reviewer judges what the tests show. Legacy JSDoc invariants remain supported, including alongside Gherkin during migration.

## What belongs elsewhere

Keep history (dates of decisions, ticket ids, "settled", who decided), plans, rollouts and evidence notes out of the design. Git and the review record hold those. Put file inventories and exclusion reasons in `.cageignore`; use `cage graph Name --used-by` for declared consumers. Keep only undecided questions under Open questions. A date used as business data is valid.

Implementation tuning belongs in code; observable business limits stay precise in the rule (for example, "at most 20 invitations a day"). An external system's assumption can be an `@assumption` Rule. A missing test for our own promise is a review gap, never a reason to relabel that promise as an assumption.

## 1. Decide what deserves a contract

A contract is a promise someone relies on: a service, a repository, an aggregate, an engine, a port to the outside world — a controller that maps an external payload, decides what is acknowledged or skipped, or encodes retry semantics is a port and gets a contract. Everything else goes to `.cageignore` (a `.gitignore`-style file next to the designs; `#` starts a comment, say why):

- helpers and pure utility functions (a line in `.cageignore`, not a contract each)
- DTOs, ORM tables, entities and schemas that only describe data (`@data` types describe their *shape* when needed). A schema with its own runtime validation promises may have a contract and linked tests; library class instances can use the explicit boundary below.
- framework wiring: NestJS modules, DI providers, route tables
- controllers and resolvers that only delegate to a service that has a contract; a controller that also composes or orders data on its own is a promise without a checkable home (decorated parameters, inferred shapes): describe that promise at a checkable boundary or propose the missing boundary; record unresolved design choices in "Open questions"

Size guidance: a module has 1–5 concrete contracts, a contract 1–7 public members and 1–7 authored rules. Core lint reports larger designs; a justified exception uses a local suppression with a reason. A larger class still has one complete contract. Reuse smaller API shapes through contract inheritance; do not split one implementation across multiple `@implements` tags. When the code has 40 exports and you can name 4 promises, that is the design; the other 36 are in `.cageignore` with a one-line reason.

What the harness can check: an exported class, including an abstract base (its instance type; a generic one only when every type parameter has a default — it is checked at those defaults), function or const. An overloaded function or a class with a required type parameter cannot carry `@implements`: describe the concrete thing built from it, or list the file with its reason in `.cageignore`. Static methods and fields use a separate `@implements-static Factory` contract; a static-only class can use that tag alone. Every public member, including inherited ones and constructor parameter properties, must occur in the class’s single contract for that surface, including its inherited API. Private/protected helpers and constructor argument lists are excluded. A file may be listed in `.cageignore` and still hold tagged declarations: tags in a listed file are read; the list only silences what is not tagged.

`.cageignore` is read like a `.gitignore`: one pattern per line, `#` comments, `name/` a folder at any depth, `*.module.ts` a file name at any depth, `dto/request/x.ts` or `/generated` a path from the module root; no negation (`!`).

From existing code: read the public surface, callers and tests to establish the intended promises. Do not infer a business requirement merely from an implementation detail, or weaken an intended promise because tests are missing. Record test gaps in the review and add the missing tests. If relevant tests are outside the configured patterns, include them when that configuration change is in scope; otherwise report the missing links. An undecided product choice belongs in Open questions. Never widen a type to make a check pass.

## 2. Write the document

Order: `# Module`, one top-level unindented `gherkin design` block, optional `## Glossary` for module terms, `ts design` blocks, optional `## Open questions` for undecided choices. Use the Feature description for context and `Not:` for non-goals. Do not add duplicate Purpose, Business rules or Out of scope sections to a new document.

````mdx
# Quota

```gherkin design
Feature: Sending quota
  Each account has a limited number of sends.
  Not: replenishing the quota.

  @Quota.take
  Rule: empty — an empty quota refuses a send
    Example: refuses when nothing is left
      Given account "a" has zero sends
      When a send is requested for "a"
      Then the request is refused
```

## Glossary
- **Send** — one unit consumed by an accepted request.

```ts design
/**
 * @data
 * @description Account identifier.
 */
export type AccountId = string;

/**
 * @contract
 * @description Keeps each account's remaining sends.
 */
export interface Quota {
  take(accountId: AccountId): Promise<boolean>;
}
```
````

### Rules and Examples

- One Rule is one observable promise in one sentence, with a kebab id: `Rule: empty — an empty quota refuses a send`. The id is unique within the carrier contract, including its JSDoc invariants.
- Bind with `@Contract` or `@Contract.member` from the same module. A Rule without its own carrier inherits the Feature's carrier. PascalCase tags always name carriers; free labels are lowercase. Syntax errors are reported before carrier binding is checked.
- Give concrete cases in Examples, normally 1–3 per rule, with short declarative Given/When/Then steps. Use domain terms rather than clicks, selectors or waits unless those actions are themselves the public promise. A case must follow from its rule; add another rule when it introduces another promise.
- An Example's title matches an active test linked by `@tests` and `@covers`. This is a link, not proof: the reviewer checks every Given, When, Then and outline row. Placeholder matching does not check `it.each` row contents. `examples` defaults to `warn`; `@property` permits no Examples but still needs tests across inputs.
- A carrier-free `@assumption` Rule states a fact about an external system. It enters the document's review material, so editing it stales those reviews; it gets no invariant finding. `@live` and Gherkin `@final` are unsupported and diagnosed.
- Background and Examples tables are authored context. This release does not type-check their cells, compare constants or run Gherkin steps. TypeScript remains the source of types.

### Families

Use `@family` for promises shared by several implementations, and one concrete `@contract extends Family` per implementation. A memberless family allows children with different signatures. Each concrete child needs its own `@implements`, test links and review, including inherited rules. Put family rules on its carrier; shared Examples need links for each concrete child. Do not merge implementations under one concrete contract or duplicate its invariant set in each child.

Rules of a `ts design` block:

- Only `import type` and exported `interface` / `type`. No classes, functions, values, `enum`, namespaces, `import()` types, `/// <reference>`.
- Every declaration has, directly above it, exactly one marker (`@contract`, `@family` or `@data`) and a non-empty `@description`.
- `@contract` goes on an interface of methods/properties (or one call signature). Optional members and readonly properties are supported. Use `extends` for shared API. Reusable `@data` bases need no implementation; a base `@contract` still needs its own implementation and passes its invariants to the derived contract. Use `@family` instead of `@contract` for an abstract shared promise with no direct implementation. A family may contain only invariants and no members, so its concrete children can have different signatures. Each named concrete `@contract extends Family` needs its own implementation, tests and review; bind `@implements` and `@tests` to those children. No own generic parameters, index signatures or overload declarations on a contract; `@data` has no such limits.
- `@invariant <id> <text>` on a method, or on the contract for a rule about the whole interface. `id` is kebab-case and unique in the contract; the text is one observable promise: what a caller sees, under what condition. For example, "returns null for an unknown id". New documents prefer a Gherkin Rule for the same promise.
- Types of another design: `import type { X } from "../other/other.cage.mdx"` (or a path alias to it). Installed package declaration types may also be imported with `import type`. Project source is forbidden except exact type exports explicitly designated in `designImportableTypes` (`src/path.ts#Export`): named `import type` of aliases, interfaces or enums only. Their transitive type/schema dependencies enter fingerprints and locks; runtime imports and other project exports remain forbidden. Describe the actual public shape of infrastructure parameters too. `unknown` is not a substitute for a narrower type: parameter/result types, parameter count, optional/rest markers and readonly modifiers must match exactly. Parameter names and equivalent aliases may differ. Assertions do not prove runtime behavior.
- For a package-class instance, `@package-instance` on a concrete contract that extends one real instantiated package class checks its class identity, exact type arguments and authored members, without recursively comparing unchanged inherited library methods. Project-added/overridden members must still be declared. This does not apply to project classes, structural lookalikes or conflicting base signatures. Use memberless families for shared validation invariants. The marker takes no arguments and is not inherited. Abstract bases may be implemented directly and exercised by test subclasses; that test does not prove every descendant's overrides.
- `@uses A B` (or `@uses A, B`) on a contract names the contracts it calls. TypeScript JSDoc `@final` freezes a declaration, `@extendable` allows additions only; use them for public APIs, then run `cage lock`.
- One tag per JSDoc line.
- The compiler compares the implementation's *inferred* types: a literal in the code (`received: true`) is `boolean` to it, so a `@data` type says `boolean`, not `true`. An external event type the code accepts (a webhook envelope) fits a contract when the `@data` type is an envelope whose payload is a union of the shapes the design names.

## 3. Check and tag

1. `cage check --phase design`, then `cage check --phase lint`. Resolve findings or use a justified local lint suppression, for example `{/* cage-lint-disable W_MODULE_SIZE: these contracts share one transaction boundary */}` before the relevant MDX block. Inside Gherkin use `# cage-lint-disable CODE: reason` before the Rule. A missing reason is an error; an unused suppression is reported. Do not change `lint` or `examples` to make a check pass.
2. Tag the code: `/** @implements Things */` above the exported class, function or const that fulfils a contract (exactly one contract per surface; above the decorators when the class has them); `/** @tests Things */` above the `describe` of its tests; `/** @covers rule-id other-id */` above each test, naming its rules; use each Example's title for its test. `@covers` resolves in the contracts named by `@tests`; a suite or a test that demonstrates several contracts names them all in one tag (`/** @tests Webhook Accounts */` on an e2e suite through a port: each id goes to the contract that has it; an id both have needs a per-test `@tests` naming one). A `@tests` line on a test itself applies to that test only. Every invariant needs at least one test that would fail if the promise were broken; write the missing tests. An explicit skipped or todo test (its own modifier or option, or its suite's) satisfies structural linkage while remaining inactive in reports. Empty tests without explicit skip/todo and tests with broken imports do not suffice: an invariant linked only to those gets `E_TEST_INACTIVE`. A declaration is a plain `it(...)` / `test(...)` with a literal title, or an `it.each(cases)("title", fn)` table counted once under its template title. Dynamic titles and helper-generated declarations cannot provide links; loops with literal tagged declarations are supported.
3. `cage check`. Fix what it reports:
   - `E_TYPE_MISMATCH`: the code does not fit the contract — change the code if the contract is right, the contract if the code is right; do not widen types to `any` or `unknown` to pass. A shape the code treats as `Record<string, unknown>` (a webhook payload) must be a `type` alias in the design, not an `interface`: interfaces have no implicit index signature.
   - A tag error in a test file (`E_TAG_FORMAT`, `E_TAG_LOCATION`) sets aside every link that tag was making, and the summary then says how many invariants are "not checked while a rejected tag names their contract": fix tag errors first, the missing tests show after.
   - `E_TEST_MISSING`: an invariant without a test.
   - `NOT_DESIGNED`: an export without `@implements` — a contract, or a line in `.cageignore` with a reason. Never list a file to silence a finding about a real promise.
4. Never delete or soften an invariant or a business rule to make the check pass. If a rule is wrong, say so in "Open questions" and ask.

Run the project's formatter on the documents you wrote if it covers `*.mdx`.

### Proposing a change as a draft

When a change to a design should be proposed before it is in force (a person or another agent decides, or the code follows later), write it as a draft instead of editing the design:

1. `cage draft create src/quota/quota.cage.mdx` writes `src/quota/quota.cage.draft.mdx`: a copy, or a new design when the document does not exist. Keep its header (`{/* cage draft v1 … */}`) as it is; edit everything below it.
2. `cage draft check src/quota/quota.cage.draft.mdx` checks it in place of the design, with the designs that import it, the locks and core lint. Lint warnings do not block; configured error severities do. Fix findings in the draft; ordinary `check --phase lint` reads only active designs. It checks no code, tests or reviews.
3. `cage draft activate src/quota/quota.cage.draft.mdx` makes it the design and removes the draft, only while the design is still what the draft was copied from. Then go on as after any design edit (section 3 from step 2): tag the code, `cage check`, `cage lock` for a new lock, and the reviews.

Drafts are never designs: `cage check` and the gate ignore them, and no code may rely on a contract that is only in a draft. On `E_DRAFT_CONFLICT` the design changed meanwhile: move the draft aside, create it again and carry your changes over. Never edit the header's digest to get past it.

### Migrating an existing design

1. Run `cage migrate gherkin <module-dir…> --dry-run`, then without `--dry-run` to create drafts. It moves contract and method JSDoc invariants, including multiline text, and retains existing Gherkin. It writes no active design or review; a differing existing draft is refused.
2. The new Feature follows the H1 and has no description. Fold Purpose into its context yourself. Fold numbered prose requirements into Rules and Examples without losing a requirement; remove the old prose only after its meaning is represented. Split packed cases into Examples, reusing test titles. Delete settled questions after preserving any resulting current requirement.
3. `cage draft check <draft>` applies design checks, locks and the project's lint policy to that candidate. Read the complete proposal before activation. Activation changes review material; no review is carried forward automatically.
4. After authorized activation, run `cage check`, the project's tests and any required or requested review. Leave drafts inactive when the task is only to propose a change.

## 4. Report

Say which contracts you wrote, which invariants, which files you put in `.cageignore` and why, and what is in "Open questions". The design is reviewed next (`cage review`); write it so that a stranger can judge it.
