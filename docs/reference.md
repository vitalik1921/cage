# cage — reference

The rules and the behaviour in full. The short introduction is the [README](../README.md).

## Usage

```sh
cage init                   # first .cage/config.json and the Stop hook; in a terminal it asks for the agent (--agent claude, codex or none skips the question)
cage check                  # designs, implementations, test links, locks, coverage, reviews
cage check --phase design   # designs only
cage lock                   # record the declarations marked @final / @extendable in .cage/lock.json
cage check --base origin/main   # additionally: everything locked on origin/main is still locked (for CI)
cage review                 # the index for a reviewer (a person or a model): the contracts without a fresh review, what changed, which invariants it touches; --all for every contract
cage review Accounts        # the material of the named contracts; --files changed (default) | all | none says how much text comes along
cage review --record verdicts.json   # record the reviewer's verdict in .cage/review.json; check then requires it
cage review --accept        # take the material of every contract without a fresh record as accepted, without a review; --all for every contract, names for some
cage check --max-diagnostics 20   # show the 20 diagnostics that matter most, count the rest by code (default 50; "maxDiagnostics" in the configuration)
cage gate                   # Stop hook for an agent: check; errors and missing or stale reviews block the stop (exit 2), the report goes to the agent
cage codes                  # what every diagnostic code means and what to do about it
```

The loop: change `*.cage.mdx` → `cage check --phase design` → change implementations and tests → `cage check` → review → the project's own `tsc` and tests.

| Flag | Meaning |
| --- | --- |
| `--root <path>` | Project root; the current directory by default |
| `--config <path>` | Configuration, relative to the project root; `.cage/config.json` by default, when it exists |
| `--format text\|json` | Report format; `text` by default. For `review` (the packet): `markdown\|json`, `markdown` by default; `review --record` and `review --accept` take `text\|json` |
| `--max-diagnostics <n\|all>` | `check` and `gate`: show at most `n` diagnostics and count the rest by code; overrides `maxDiagnostics` in the configuration (50) |
| `--all` | `review` without names: list every contract, not only those in need of a review |
| `--files changed\|all\|none` | `review <Name…>`: the text a packet carries — the lines that changed since the recorded review (the default; everything when there is no review to compare with), every file whole, or none |
| `--accept` | `review`: record the material of the selected contracts as accepted without a review (see "`review`") |
| `--help`, `--version` | Help and version |

**The text of a diagnostic** is `CODE: what (file:line:column)`: the code says what kind of thing it is, the message names the thing — a contract, `Contract.invariant`, a tag, a file — and the place closes the line; a message's further lines (the parts that changed, the tests that cannot run, the files past the bounds, a compiler's explanation, the reason of a weak finding) follow indented, one a line. A `REVIEW_STALE` message names ten parts at most and counts the rest (`cage review <Name>` lists them all). The severity is the code's prefix: `E_` fails the check, `W_` does not. No line says what a code means or what to do about it: that is `cage codes`, one line per code (and the table under "Codes" below), so that a report of fifty findings is fifty facts, not fifty paragraphs.

```text
W_REVIEW_STALE: Quota (src/quota/quota.cage.mdx:16:18)
  - test "takes exactly one send" (src/quota/quota.test.ts) changed
E_TEST_MISSING: Quota.consume (src/quota/quota.cage.mdx:20:6)
E_TYPE_MISMATCH: MemoryQuota does not fit Quota (src/quota/memory-quota.ts:2:14, TS1360)
  Type 'MemoryQuota' does not satisfy the expected type 'Quota'.
  contract (src/quota/quota.cage.mdx:16:18)
```

The report goes to stdout, argument errors to stderr. Exit codes: `0` — success (warnings do not change it); `1` — a rule is violated: errors in the designs, an implementation that does not fit its contract, a missing implementation or test link; `2` — invalid arguments, configuration or environment (tsconfig, file system).

**How much is shown.** `check` and `gate` print at most `maxDiagnostics` diagnostics (50 by default; `--max-diagnostics <n|all>` on the command line), the ones that matter most: configuration and environment errors, then other errors, then missing or outdated reviews, then the remaining warnings; within a rank the order of the report. What is left out is one line — `7 more not shown (4 W_REVIEW_MISSING, 3 W_NO_INVARIANTS): the report shows 14 at most. …` — and in JSON `omitted` (`limit`, `count`, `errors`, `warnings`, `byCode`). The exit code, `ok`, the counts and the summary line are of everything found: a limit changes what is shown, not what was checked. `0` shows the counts by code and the summary only.

### What `check` checks

The design phase first, in five layers:

1. **Documents.** MDX is only parsed (`unified` + `remark-parse` + `remark-mdx`), never executed. Top-level, unindented `ts design` blocks are taken; plain `ts` blocks stay examples.
2. **Blocks.** Every block has to be complete TypeScript on its own: an unclosed `{` or `/*` cannot swallow the next block.
3. **Compiler.** An unusable tsconfig, invalid options or missing `types` are an environment error; nothing further is checked.
4. **Declarations and tags.** The rules below.
5. **Types.** The blocks of all documents of a module are joined into one module. The modules of all designs are given to the compiler from memory as virtual files `<module>/.cage/design.ts`, which never exist on disk; an import between designs by document path is rewritten to the virtual file, and messages show what the document says. Compiler errors are mapped to the line and column of the document.

A layer runs only when the earlier ones left no error that its results would be a consequence of. Design diagnostics point at the line and column of the original MDX.

`cage check` without `--phase design` continues when the designs have no errors:

6. **Implementations.** Every contract has at least one declaration tagged `@implements` (`E_IMPLEMENTATION_MISSING`), and the compiler accepts it in the contract's place (`E_TYPE_MISMATCH`, with the compiler's explanation).
7. **Tests.** Every invariant has at least one test declaration tagged `@covers` inside a suite tagged `@tests` with its contract (`E_TEST_MISSING`), and at least one of them is active as its text shows (`E_TEST_INACTIVE`; see “Rules for tests”). The tests are read, never run: whether they pass is the test runner's to say, and `counts.executedTests` is always `null`.
8. **Reviews.** Every contract has a recorded verdict of a substantive review for the material as it is now, or an acceptance of that material without a review (`cage review --accept`): `REVIEW_MISSING` / `REVIEW_STALE` / `REVIEW_WEAK`, warnings or errors depending on `"review"` in the configuration (see "`review`").

### Rules for implementations

- `@implements A` stands in the JSDoc directly before an exported, named `class`, `function` or `const` (one plain name) in an ordinary `.ts` file. When the class has decorators, the tag goes above them. Test files, `.design` and `.d.ts` files are not implementations.
- Exactly one name of an existing contract; one tag per declaration.
- What is compared is the instance type of the class or the type of the function or constant. Extra public methods, private members and constructor parameters are no concern of the contract.
- A default export, a non-exported declaration, `let`, destructuring, an abstract class, a generic class without defaults for all of its type parameters (with defaults it is checked at them), an overloaded function and a declaration without code (`declare`) are not supported: `E_UNSUPPORTED_DECLARATION`. One declaration may implement several contracts: `@implements A B`, or one tag per contract; each is checked on its own.
- The native `implements` is not needed and creates no link; only the tag does.
- Type errors in a file where `@implements` stands on a declaration are reported as `E_TYPESCRIPT`: the types of such a file cannot be relied on. The harness does not check the other files of the project. A file with syntax errors is not read at all.
- The guarantee is ordinary TypeScript assignability. `any`, type assertions and method parameter bivariance pass, as in the compiler itself. `@ts-nocheck` or `@ts-ignore` in an implementation file hide its own type errors but not a mismatch with the contract: the comparison is made outside that file. `W_WEAK_TYPECHECK` warns when `strictNullChecks`, `strictFunctionTypes` or `noImplicitAny` is off.

### Rules for tests

`node:test` (the default) and Vitest are supported: `"testAdapter": "vitest"` in the configuration. The rules are the same.

- `@tests A` stands in the JSDoc directly before a `describe` / `suite` call; nested suites inherit the contract, a nested `@tests` replaces it for its suite. `@tests A B` names several: a test through a port (an HTTP handler) often demonstrates what the port and the service behind it promise.
- `@covers a b` stands before an `it` / `test` call inside such a suite and names invariants of the contracts in effect. Each id goes to the one named contract that has it; an id two named contracts share is `E_REFERENCE_AMBIGUOUS` (give the test its own `@tests` naming one), an id none has is `E_REFERENCE_UNKNOWN`. One test may cover several invariants of several contracts; one invariant may have several tests. A test tagged for two contracts is one declaration in the count and a test of each in the reviews.
- `@tests A` may also stand on the test itself, on its own line before `@covers`: for a test without a `describe`, or to narrow a suite's contracts for one test. Such a tag applies to that test only. One `@tests` line per comment: the names go in one tag.
- The functions are recognised by their import from the runner's module, not by name: aliases and namespace imports work, for `node:test` also the default import; a local function named `it` is not a test. Vitest globals `describe` / `it` are recognised when the project includes their types (`"types": ["vitest/globals"]`).
- `.skip`, `.only`, `.todo`, options and empty callbacks are still declarations, and their `@covers` still link. For Vitest also `.concurrent`, `.sequential`, `.fails`, `.shuffle`, chained or not.
- **Inactive declarations.** A declaration is `skipped` or `todo` when its own modifier (`.skip`, `.todo`) or option (`{ skip: true }`, `{ todo: "reason" }`, a non-empty string counting as on) says so, or when an enclosing suite's does — the outermost reason is the one reported; it is `empty` when it has no callback, or a callback whose body is an empty block. The callback is the argument that is callable, wherever it stands — node:test's `(name, options, fn)`, Vitest's `(name, fn, timeout)` and `(name, options, fn)` — so titles, options objects and timeouts, inline or named, are passed over, and named options with nothing callable after them mean no callback. A callback with an empty block counts whether it is inline or named in the same file: a function declaration, a method, a `const` holding a function, or a trivial alias or object property (shorthand included) leading to one, followed a few steps with cycle protection. A declaration is `broken-import` when its file has an import the compiler shows to be broken without running anything: a relative import of a script (`.ts`, `.js` and their kin, or no extension) that resolves to no file, or a value import (named or default) of a name that the project file it resolves to does not export — the compiler rejects such a file, and Node does not load it as an ES module, so none of its tests can be relied on to run; the reason names the import and its line. So is a value import of a name the file exports only as a type — an interface, a type alias, or a value passed on by `export type { x }`, `export type * from` or `export type * as ns` — followed through aliases and re-exports: where imports are kept as written such a file does not load. That is always so for node:test, whose files Node runs with its own type stripping, and for any runner under `verbatimModuleSyntax`; Vitest's transform drops an import used only in types, so there it is broken only under `verbatimModuleSyntax` or when the name is used as a value. A node:test project that runs its tests through a transpiler which drops such imports (`tsx`, `ts-node`) still gets the finding: `import type` fixes it for every runner. Only the imports are looked at: type-only imports (`import type`, `{ type X }`) are erased and do not count, and packages, files outside the project, declaration files, files that are not scripts (JSON, styles) and CommonJS `export =` modules are the runner's to resolve. Other type errors in a test file are not reported: cage does not type-check tests, the project's own `tsc` does. A callback imported from another file, held in a `let` or `var`, returned by a call or computed otherwise is not followed and counts as `active`: the file does not show its body. So does an argument the compiler cannot type (`any`), when no other argument is callable. Otherwise it is `active`. An invariant whose every linked declaration is inactive is `E_TEST_INACTIVE` at the invariant, listing the tests and why; an inactive declaration linked to invariants that do have an active test is `W_TEST_INACTIVE` at the test, naming just those invariants — so one skipped test covering `a b` beside an active test covering only `b` gives the error for `a` and the warning for `b`. This is **structural detection, not semantic proof**: an active test may still assert nothing or the wrong thing (that is the review's to judge), an option computed at run time (`{ skip: flaky }`) counts as active, and a runner may skip a test for reasons its text does not show. Only running the tests shows what ran.
- `it.each(...)("title", fn)` and `describe.each(...)` are one declaration with their template title (`%s` stays text); the cases inside are not counted on their own. `it.skipIf(...)` and other forms that decide at run time are not declarations.
- Declarations are read at the top level of the file, in blocks and loops, and in the inline callbacks of suites. Inside a test's callback and any other function there are no declarations: subtests (`t.test`), helpers that generate suites and `await describe(...)` are not supported, and a tag on them is `E_TAG_LOCATION`.
- A tagged suite or test has a literal title; a suite an inline callback. Otherwise `E_UNSUPPORTED_DECLARATION`.
- `@covers` without a contract — no `@tests` on the test or on a surrounding suite — is `E_TEST_CONTEXT`.
- An unknown contract in `@tests` is reported once; the `@covers` inside are not checked further.
- Tests without tags are left alone.

In ordinary files only JSDoc comments that contain a binding tag (`@implements`, `@tests`, `@covers` or a design tag) are checked. `@description` on its own is ordinary JSDoc. The harness does not lint the rest of the project's comments.

### Rules for `ts design` blocks

- A block may contain only `import type` and exported `interface` / `type`. Classes, functions, variables, enums, namespaces, re-exports, value imports, `import("…")` in types and non-exported declarations are errors.
- Only types of other designs in scope may be imported, through the path of any of their `*.cage.mdx` documents (relative, or a `paths` alias). Importing implementations, packages, `.mdx` or any `/// <reference>` is `E_DESIGN_IMPORT`; importing a `*.cage.mdx` document that is not in scope is `E_DESIGN_OUT_OF_SCOPE`.
- Every declaration has, in the JSDoc directly before it, exactly one marker, `@contract` or `@data`, and a non-empty `@description`. "Directly" means only whitespace and line breaks between the comment and the declaration. A comment that ends the line of the previous declaration belongs to it, not to the next one.
- `@contract` goes only on an interface that has either one or more ordinary methods or exactly one call signature. Generics, `extends`, optional methods, properties, index signatures and overloads are not supported. `@data` has none of these limits; note that a `@data` shape the code passes where it expects `Record<string, unknown>` has to be a `type` alias, since an `interface` has no implicit index signature.
- `@uses A B` goes on a contract; the names have to be contracts in scope, not the contract itself.
- `@invariant id text` goes on a contract or one of its methods. `id`: lower-case Latin letters, digits, hyphens. Ids are unique within a contract; different contracts may share them. An invariant on a call signature belongs to the contract as a whole.
- Contract names are unique across the whole scope. `@data` names only within a module.
- A tag starts a JSDoc line; the following lines continue its text up to the next tag. `@` in the middle of a sentence is not a tag. A punctuation mark right after the name (`@invariant: id …`) keeps the line a tag, and that tag has the wrong format. Tags are not read from strings, `//` and `/* */` comments, MDX prose or plain `ts` blocks.
- Names in `@uses` are TypeScript identifiers, Latin or not.
- A harness tag out of place is `E_TAG_LOCATION`: in an unattached JSDoc, on a field of a data type, `@implements` / `@tests` / `@covers` in a design. A JSDoc at the end of one block does not describe the declaration of the next.
- An unknown tag in a design's JSDoc is `E_UNKNOWN_TAG`; the deferred `@name` and `@open` are `E_UNSUPPORTED_TAG`. The standard `@param`, `@returns`, `@return`, `@example`, `@deprecated`, `@remarks`, `@see`, `@throws`, `@typeParam`, `@template` are allowed.
- `@ts-nocheck`, `@ts-ignore`, `@ts-expect-error` are forbidden in any comment of a block, in any case and spelling: the check is deliberately wider than what the compiler recognises.
- Modules cannot depend on one another in a cycle (`@uses` and type imports together): `E_DESIGN_CYCLE`, with the path. Dependencies within a module are not a cycle.
- A scope without a single contract is `E_NO_CONTRACTS`. A module with only `@data` is fine.
- Warnings: `W_NO_INVARIANTS` for a contract without invariants, `W_BUSINESS_CONTEXT_MISSING` for a document without paragraphs, lists or tables outside code blocks.

### What the design does not cover: `W_NOT_DESIGNED` and `.cageignore`

`cage check` finds the code of a module that its design does not describe: every exported `class`, `function` or `const` in a module with a design that carries no `@implements`. For a person or an LLM this is the list of what still needs a contract. The level is `"coverage"` in the configuration: `"warn"` (the default) — a `W_NOT_DESIGNED` warning, `check` and `cage gate` let it pass; `"require"` — an `E_NOT_DESIGNED` error, exit code 1 and the gate blocks; `"off"` — not checked. So the project decides whether a gap in design coverage stops the agent or is only shown.

A file belongs to the nearest module above it. Code outside modules with a design, tests, types (`interface`, `type`), `enum`, default exports and `declare` are not checked.

What needs no design is listed in a `.cageignore` file next to the module's designs; it is committed. For an LLM an entry means: no design is to be generated for this. For the harness: do not warn.

```gitignore
# Drizzle tables, zod schemas and NestJS wiring have no behaviour of their own.
entities/
dto/
*.module.ts
/generated
```

The format is that of `.gitignore`, paths from the module root: a name (`*.module.ts`, `entities/`) matches at any depth, a path with a slash (`dto/request/upsert.ts`, `/generated`) counts from the module root, `#` starts a comment. Negation (`!`) is not supported. Tags in a listed file are still read.

### Locks: `@final` and `@extendable`

A tag on a contract or data type says how far the declaration may change. It is a direction for a person and for an LLM agent editing the design.

| Tag | Meaning |
| --- | --- |
| `@final` | The declaration does not change: no signature, no invariant, no member added or removed |
| `@extendable` | What is there does not change; members and invariants may be added. Interfaces only |
| no tag | Open to change and extension |

To notice a change, the harness compares the design with the record in `.cage/lock.json` (committed):

- `cage lock` records the declarations the file does not have yet, and the new members and invariants of `@extendable` declarations. It never changes what is already recorded.
- `cage check` compares, in both phases. A marked but unrecorded declaration is `E_LOCK_MISSING`. A violation is `E_LOCK_VIOLATION`, listing the changes: what changed, was removed or added, and what it was.
- New named members and invariants of an `@extendable` declaration pass, but until the next `cage lock` they give a `W_LOCK_UNRECORDED` warning: they are not protected yet. Type parameters, the base type (`extends`) and a call signature are not extensions: they change what is already there.
- Locks are compared only with a design without errors: a rejected tag does not look like a lifted lock.
- Removing the tag or deleting the declaration does not get around a lock: the record stays, and `check` reports it. A lock is lifted or changed deliberately only by deleting its record from the file by hand; such an edit is visible in the diff.

Anyone can edit the lock file, including an agent. So in CI `cage check --base origin/main` compares the current lock file with the one recorded at the given revision: every lock from there has to remain in the current file, unchanged and no weaker (`@extendable` → `@final` is allowed, the reverse is not; `@extendable` may have more members and invariants). Otherwise `E_LOCK_BASE`. A lock that is already on the main branch never passes this check when lifted: a person has to merge such a change deliberately, against a red check. The revision has to be available locally (in CI the branch may need a `git fetch` first); an unknown revision is `E_ENVIRONMENT`. A revision without a lock file requires nothing. The project may live in a subdirectory of the repository.

Signatures are compared, not text: formatting, comments, the kind of quotes in string literals, the order of blocks and the prose do not affect a lock. The content of a string literal is part of the type. A property name with and without quotes are different spellings.

A contract's lock covers its invariants too: the id and the text of each. Line breaks in the text do not matter; a change of words does. Descriptions (`@description`) and `@uses` are not covered.

A lock applies to exactly the declaration it stands on. When a locked declaration refers to a contract or data type without a lock, a change of that type changes it too, and the lock does not notice. The harness warns about every such type: `W_LOCK_OPEN_TYPE`, at the first reference. The warning goes away once the type is marked `@final` or `@extendable`.

### `review`: the material of a substantive review

`cage check` sees that a test is *tagged* with an invariant, but not whether it *checks* it. Only someone who reads the invariant, the test and the code together can judge that. `cage review` collects everything needed for it and sends nothing anywhere: calling a model is outside the harness.

**The index.** `cage review` without names does not export material: it lists, one entry per contract, what a reviewer needs to choose where to start — the contracts without a recorded verdict or acceptance for their material as it is now (`--all`: every contract, with its status), the invariants, the number of files of material, what the check found about the contract, and for an outdated review the parts that changed since it (`changed`: the part's key, kind, `changed` / `new` / `gone`, file and line, the implementation's name or the test's title) and the invariants that touches (`touched`: those a changed or new test covers now; those whose previous finding rests, by the `file:line` of its evidence, on the lines of a changed test, since a test re-tagged away from an invariant has changed and the finding cited it; those with a previous finding and no linked test any more; and all of them when the contract, the prose, an implementation or a dependency changed, when a test is gone, since what it covered is not known any more, or when no part differs by its digest while the fingerprint does — the parts in another order, or the record edited — since then nothing can be told apart). A test re-tagged away from an invariant that other, unchanged tests still cover, with a previous finding whose evidence cites none of its lines, is not told apart: the record holds digests, not tags. In Markdown one line per contract, the changed parts beneath; in JSON a `ReviewIndex` with `selection`, `contracts` and `diagnostics`. Exit code: `0` — the index was made; `1` — the designs could not be indexed; `2` — configuration or environment.

**The packet.** `cage review <Name…>` exports the material of the named contracts. A full `check` runs first. In Markdown the packet is facts, without instruction or legend — the reviewer's instruction is the `cage-review` skill's and this section's, and the JSON report still carries it as `instruction` with `resultFormat` and `resultSchema` for a reviewer without the skill. It opens with the contract's lines: `fingerprint`, `design` (its documents and the designs it uses), `description`, `lock` when locked, `review` (`none`, `outdated, N parts changed, touching K of M invariants`, `accepted without a review`, `current: 3 adequate, 1 weak`, or `not known`), `tests` (how many are active in their text; cage runs none) and `check` (the codes found about the material, each with its thing and place). For an outdated review a `## Changed` list follows with `touches:` naming the invariants to judge afresh and those to confirm or revise. `## Invariants` gives each invariant with its text, its tests by file and line, and the previous finding (`recorded: adequate, "first sentence" (evidence), changed|unchanged`). `## Code` names the implementations, the members, the test files with their inactive tests, the fingerprinted dependencies, the test helpers, what the contract uses and is used by, who uses it outside the module, the previous review's notes, the test files without tags and the files not loaded — each line only when there is something to say. Then the text that comes along (`## Changed material` or `## Files`), and `## Verdict`: the JSON template `cage review --record` reads, with the fingerprints filled in. For every named contract the JSON packet holds: the description, the methods, the invariants with their linked tests, the implementations, the dependencies (`@uses` and the type-import closure), the diagnostics about the contract or its files, and the list of files **not loaded**: what the implementations and tests import from the project that the packet does not contain (helpers, a schema). The files — the `*.cage.mdx` of the module and its dependencies, the implementations, the files of the linked tests, and the project files the test files import (a stub or a fixture decides what a test observes) — are named with their lines in every packet; how much of their text comes along is `--files`: `changed` (the default) — for a contract with an outdated review the lines each changed part was taken from (`excerpts`: the part, its file, and its pieces numbered as in the file — a test's statement with its doc comment, its setup and the declarations it refers to; an implementation's statement and what it refers to), and whole only a changed design document or dependency file, which have no smaller part; for a contract with no review to compare with, every file, as `all`; `all` — every file whole, once per document; `none` — no text at all, the reviewer opens the files. The packet also repeats, per invariant, the **previous findings** of the recorded review (`prior`) and whether the invariant's material changed (`touched`), so that an unchanged judgement is confirmed or revised rather than made again; `changed` and `touched` on the packet say the same as the index. In Markdown the fence is longer than the longest run of backticks in the content, and the verdict template closes the document.

Every packet has a **fingerprint**: a digest of every part of the material, recorded part by part in `review.json` so that `REVIEW_STALE` says what exactly changed. The parts:

| Part | What it holds |
| --- | --- |
| `contract` | The contract's declaration with its doc comment, so with its invariants. |
| `design <file>` | The prose of each document of the contract's module, with its `ts design` blocks replaced by markers: the business rules a reviewer judges against. Another contract's declaration in the same document is that contract's material, not this one's. |
| `implementation <file>#<name>` | The top-level statement of the implementation, then the top-level declarations of the same file it refers to (functions, classes, variables, types), followed transitively. |
| `test <file>:<title>` | The test's statement; its setup — the runner hooks in effect for it, at the file's top level and in each enclosing suite, recognised by their binding to the configured runner like declarations are (`beforeEach as setup`, `runner.beforeEach`, node:test's default export, Vitest's globals when the project loads their types; a local function that merely has a hook's name is not one), and the variables, functions and classes declared in its suites' callbacks and in the plain blocks and loop bodies around it, with the headers of those loops (`for (const left of [0, 1])`); and the top-level declarations of the same file any of these refer to. This is text, not a data-flow analysis: an edit to any of it makes the review outdated, whether or not the test observes it. The hooks are node:test's `before`, `after`, `beforeEach`, `afterEach` and Vitest's `beforeAll`, `afterAll`, `beforeEach`, `afterEach`. |
| `dependency <file>` | A local file that an implementation or test file imports, whole. |

Dependencies are found breadth first from the files of the contract's implementations and linked tests, each level in path order, following value imports (`import`, `export … from`, `import x = require(…)`) as the project resolves them. Not followed and not fingerprinted: type-only imports and exports, dynamic `import()` and `require()` calls, unresolved specifiers, files outside the project root, in `node_modules`, declaration files, and files matching `exclude` or `reviewDependencies.exclude`. The contract's own implementation and test files are parts already. A file of another contract's implementation is fingerprinted but not followed: what it imports is that contract's material. The bounds are `reviewDependencies.depth` (import levels, 3 by default) and `reviewDependencies.maxFiles` (40 by default): whatever they leave out is named by `check` in `REVIEW_SCOPE_LIMIT` at the contract — a warning under `"review": "warn"`, an error under `"require"` — as a fact about the project's setting, without advice: the message is read by agents, and the bounds are a person's to set (the rules for the agent say not to touch them). The review packet and index do not carry it: the packet lists the fingerprinted files instead, so that a reviewer sees what is covered without being sent to the configuration. A dependency that cannot be read, at any depth, is `E_ENVIRONMENT` at the contract: the packet carries it, `complete` is `false` and `cage review` exits 2, and `cage review --record` records nothing (the review file stays byte for byte what it was), since a fingerprint without that file is not the material. **The project's boundary is its real path.** Before any file is read into a packet or a fingerprint, its real path — every symbolic link resolved, nothing opened — must lie under the real path of the root; a project opened through a link to it is read as usual. A file a link takes out of the project is never read: as a dependency it is a `REVIEW_SCOPE_LIMIT` hole (“a link out of the project”), as a helper of the tests `W_OUTSIDE_ROOT` at the link. The compiler resolves a relative import to the path it is written as, inside the project, with or without `preserveSymlinks`: only this check keeps the content out. Recording a verdict is not refused for such a hole, as for any part the bounds leave out: cage has read everything it may read, and under `"review": "require"` `check` keeps reporting the hole as `E_REVIEW_SCOPE_LIMIT`. The packet lists the fingerprinted dependencies (`fingerprinted`). An e2e spec that boots the whole application reaches every file of it; excluding the entry point (a NestJS `AppModule`, say) keeps the fingerprint to what the contract's own code imports.

The fingerprint does not change for edits outside the parts: another test in the same file, a function of the file nothing in the material calls, a comment outside the statements, another module's design, line endings. A review recorded before this scope existed has fewer parts; the next check names the parts that are new.

The packet also shows **who uses the contract from outside** (`usedBy`): the files outside the module that import its implementation, with the contract's members they call on it as far as the syntax shows (`this.accounts.findById(…)` on a property or parameter declared with the implementation's type); when the declaration changes, `REVIEW_STALE` names them, because they rely on the old promise. The list of files **not loaded** holds what the implementations and the test files import; what a helper imports is not followed (an application module imports everything), and a file another packet of the same report holds is not listed. The **notes of the previous review** — its contract-level findings, first sentence each — are repeated in the packet, so that an observation stays in front of the next reviewer until the design's owner acts on it. The summary of `check` keeps four things apart: `tests: D declarations (A active), L of N invariants linked, K to an active test, not run by cage; reviews: R attested adequate, W found weak, U unreviewed`, and, when there are any, `C contracts accepted without review (I invariants)`. A link is a tag, active is what the test's text shows, running is the test runner's job, an attestation is a recorded reviewer's verdict, and an acceptance is none of these. In JSON: `counts.activeTestDeclarations`, `counts.activeInvariants`, `counts.executedTests` (always `null`), `counts.reviewedInvariants`, `counts.weakInvariants`, `counts.acceptedInvariants`, `counts.acceptedContracts`, and `activeTestCount` and `review` on every invariant.

The packet keeps apart what cage knows: what it collected (not judged), whether the tests are active in their text (not whether they pass: cage does not run them), what the check found, and what `.cage/review.json` holds — a verdict is a reviewer's assessment, not a proof, and an acceptance is not even that. The marks are `✓` known and in order, `!` needs a look, `✗` missing, outdated or an error, `○` not done or not known by cage; the JSON packet has the same facts as `recordedReview` (`none`, `outdated`, `current`, `unknown` when the review file cannot be used) and a `status` for every test declaration; `recordedReview.contractAssessments` counts the findings about the contract as a whole apart from `assessments`. `--record` marks a recorded contract `✓` when every finding, about an invariant or the contract as a whole, is adequate, and `!` otherwise; the packet's line is `!` in the same case, and agrees with what `check` reports as `REVIEW_WEAK`.

Exit code of a packet export: `0` — the export was made, even when `check` found errors (then `complete: false`, and the errors are in the packet); `1` — an unknown contract, or the designs could not be indexed; `2` — configuration or environment.

The reviewer returns the **verdict** in the format the packet describes at its end (`resultFormat`): for every contract its fingerprint and its findings — `invariant` (an id, or `null` for the contract as a whole), `assessment` (`adequate`, `weak`, `unrelated`, `insufficient-context`), `reason`, `evidence`, `suggestedChange`. A contract may carry several contract-level findings (`invariant: null`) next to the per-invariant ones: observations about the design or the code, assessed `adequate` so that the check does not fail on them. A contract-level finding assessed `weak`, `unrelated` or `insufficient-context` is a finding against the contract as a whole (for a contract without invariants it is the only way to say so): it is recorded, counted apart from the invariants, and `check` reports it as `REVIEW_WEAK` at the contract — so `--record` marks the contract `!`, the packet's status shows the count, and the summary of `check` adds “N contracts found weak as a whole”. `cage review --record verdicts.json` (a path relative to the current directory) validates it and records it in `.cage/review.json` (committed): the contract, the fingerprint, the digest of every part of the material, the findings. It prints, per contract, the count of each assessment over the invariants, the contract-level assessments when one is not adequate, and the notes apart (`! recorded  Accounts (2 adequate, 3 weak; the contract as a whole: 1 weak; 2 notes)`, then each note, led by its assessment when that is not adequate); the JSON report has `assessments` and `contractAssessments` per contract. It refuses, and then records nothing: when the fingerprint does not match the material as it is now (`E_REVIEW_VERDICT`: the material changed after the review), when an unknown contract or invariant is named, when an invariant is left unassessed, when a contract without invariants has no finding, when there are two verdicts for one contract, or when a finding — about an invariant or the contract as a whole, whatever its assessment — has a blank `reason`, or a null or blank `evidence` (only an `insufficient-context` finding may have `evidence: null`; a blank string is refused for it too). The packet's `resultSchema` says the same. These rules are the documented shape of a verdict, now enforced when it is recorded: a verdicts file that `--record` of 0.2.5 accepted without a reason or evidence is refused now, while review files already recorded are read as they are. A complete verdict is still an assessment, not a proof. A verdict recorded earlier for the same contract is replaced; entries of contracts that no longer exist in the designs are removed (`check` reports them as `REVIEW_STALE` until then). Digests are computed with `\n` line endings: a CRLF checkout of the same files changes nothing.

Then **`cage check` requires the reviews**. For every contract: no record — `REVIEW_MISSING`; a record whose material changed since — `REVIEW_STALE`, naming the changed parts; a finding that is not `adequate` — `REVIEW_WEAK` at the invariant, with the reason and the suggestion. The level is `"review"` in the configuration: `"warn"` (the default) — `W_REVIEW_*` warnings, `"require"` — `E_REVIEW_*` errors and exit code 1, `"off"` — nothing. Full `check` only: `--phase design` has no review material.

So the review is a second gate: change a test, the code or the design, and `check` is red until there is a fresh verdict.

**Accepting without a review: `cage review --accept`.** A project that adopts cage with many contracts, or a module nobody will review now, can take its material as it is: `cage review --accept` records in `.cage/review.json`, for every contract without a fresh record (the same selection as `cage review`), an entry with the fingerprint and the digests of the material as it is now, `"accepted": true` and no findings. `check` then asks for no review of it until the material changes — then `REVIEW_STALE` says that the *acceptance* (recorded without a review) is for other material, and asks for a review, not for another acceptance — and counts it apart: `review` is `"accepted"` on its invariants, `counts.acceptedInvariants` and `counts.acceptedContracts` hold the totals, the summary adds `N contracts accepted without review (M invariants)`, and nothing is attested adequate. The packet's status line says `Recorded review: none — this material was accepted without a review` (`recordedReview.status` is `"accepted"`), and `cage review` without names leaves accepted contracts out, like reviewed ones. `cage review --accept Name` accepts the named contracts, replacing a verdict as well; `--accept --all` does so for every contract; without names a fresh verdict is kept. An acceptance already recorded for the same material is kept as it is (`kept` in the report). An unknown name, or a dependency that cannot be read, refuses the whole run and records nothing; entries of contracts that no longer exist are removed, as `--record` does. A verdict recorded later replaces the acceptance. It is a person's decision, visible in the diff of `.cage/review.json`; the rules for the agent say not to run it on its own.

**Who reviews.** The harness never calls a model: it has no network and no provider. The reviewer is the agent that works on the code anyway, in its own environment (Claude Code, Codex or another), because every such environment has its own stop gate — a hook that runs by itself. The loop:

1. The hook before the agent's stop runs `cage gate`: a `check` in which errors, and a missing or stale review whatever the `"review"` level, block the stop — exit 2, the report and the hint go to the agent as feedback. A weak finding blocks only under `"review": "require"`, where it is an error: a recorded judgement is not something the agent can always act on in the session, while a change without a fresh look is. After three blocks in a session the gate lets the agent go with the report, so that a check that cannot be fixed does not hold the session forever; the hook protocol (`session_id`, `stop_hook_active`) is read from stdin.
2. The agent sees `REVIEW_MISSING` / `REVIEW_STALE`, runs `cage review`, reads the packet, writes the verdict into a file in the format from the end of the packet, and runs `cage review --record <file>`.
3. `cage check` is green; the agent may stop.

`cage init` asks which agent to set up — `claude`, `codex`, both, or `none` for the configuration only — with no default: a blank or unknown answer is asked again (five times at most, then exit 2), and the end of input (Ctrl-D) cancels with exit 130; Ctrl-C ends it the usual way. The question is asked only when stdin and stderr are a terminal and goes to stderr, so `--format json` stays parseable; elsewhere (a pipe, CI) `init` without `--agent` is a usage error (exit 2) that names `--agent claude|codex|none`. Nothing is written before the answer. A file that is already there is kept or added to, never overwritten, so a second run, with the same or another answer, keeps what a person has edited. `cage init` sets all of this up: the `Stop` hook entry in `.claude/settings.json` (one line: `cage gate --root …`; the harness is a devDependency of the project) or `[[hooks.Stop]]` in `.codex/config.toml`, and the section with the rules for the agent in `CLAUDE.md` / `AGENTS.md` (among them: never lower an assessment or remove an invariant for a green `check`). The hook commands pass every path as data: each path is a single-quoted shell word (`"$CLAUDE_PROJECT_DIR"/'apps/my api' `, a `'` written as `'\''`), the project directory of Claude Code is the one variable, and the Codex command is a TOML basic string with its quotes and backslashes escaped — so a `$`, a backtick, a quote or an apostrophe in a directory name is never expanded and never breaks the file. A hook is taken for this project's gate only when its command, parsed as a shell would, runs an installed `cage` with `gate`, the options of gate and `--root` naming this project, with no other expansion, separator, redirection or comment; commands written by earlier versions of init are recognised. Anything else is kept as it is and the gate is added beside it — nothing is removed — and a command that mentions `cage gate` without being a gate is `W_GATE_COMMAND`. The rules go in behind the marker `<!-- cage:rules -->` (or are found by their `Contract harness` heading, as an earlier init wrote them); a mention of `cage check` elsewhere in the file does not count, and an edit inside the section keeps it the project's. The text of the rules is `plugin/rules.md`, shipped with the package; the Claude Code plugin in `plugin/` brings the same rules, the skills and the hook without `init`. Another environment needs the same hook by its own means. The verdict is made by the same agent that wrote the code; the trace stays in the diff of `.cage/review.json`, and in CI `cage check` with `"review": "require"` lets no contract through without a fresh verdict. A CI agent may run the same loop once more.

### The JSON report of `check`

`schemaVersion`, `command`, `phase`, `ok`, `scope` (tsconfig, design files, the TypeScript used, the effective `strictNullChecks` / `strictFunctionTypes` / `noImplicitAny`), `counts`, `invariants` with `linkedTestCount`, `activeTestCount` and `review` (`adequate`, `weak`, `unrelated`, `insufficient-context`, `accepted`, or null), `index` (contracts with their methods, locks and implementations, data types, `@uses` and type-import edges between modules — for a tool or an agent that needs the index rather than the documents), `omitted` (what `maxDiagnostics` left out of `diagnostics`: `limit`, null when none applied, `count`, `errors`, `warnings`, `byCode`), `diagnostics`. `counts.testDeclarations` are the tests inside suites tagged `@tests`, `counts.activeTestDeclarations` those of them that are active; `counts.linkedInvariants` the invariants with at least one link, `counts.activeInvariants` those with an active one; `counts.executedTests` is always `null`, because cage runs no test; `counts.reviewedInvariants` and `counts.weakInvariants` are what fresh recorded reviews attest, `counts.weakContracts` the contracts whose fresh review has a finding about the contract as a whole that is not adequate; `counts.acceptedInvariants` and `counts.acceptedContracts` what was accepted without a review; `counts.uncheckedInvariants` the invariants not checked for a test because a rejected tag names their contract (the summary line says so too).

What was not checked is `null` or `"not-checked"`, never `0`: "not checked" differs from "not found". The design phase never looks at implementations and tests; a full check does not reach them when a design has an error; and when an error stopped the check before the designs were indexed, the counts of contracts, data types and invariants are `null` too. There is no `passed`, `failed` or coverage percentage. Equal `@uses` and imports from one design count as one dependency. The report is deterministic: no time, no random ids.

### Configuration

`.cage/config.json` is optional. The defaults:

```json
{
  "version": 1,
  "tsconfig": "tsconfig.json",
  "designs": ["src/**/*.cage.mdx"],
  "implementations": ["src/**/*.ts"],
  "tests": ["src/**/*.test.ts", "tests/**/*.test.ts"],
  "exclude": ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
  "testAdapter": "node:test",
  "review": "warn",
  "coverage": "warn",
  "reviewDependencies": { "depth": 3, "maxFiles": 40, "exclude": [] },
  "maxDiagnostics": 50
}
```

- `version` is required; unknown fields and wrong types are an `E_CONFIG` error.
- Missing fields take the defaults; a given array replaces the default entirely.
- Paths and patterns count from the project root.
- `**` and `*` do not match dot directories: `.cage` in a pattern has to be named explicitly.
- Only a `*.cage.mdx` file is a design; other files the pattern matches are ignored.
- Symlinks are not followed during discovery.
- `implementations` and `tests` say in which files `cage check` looks for `@implements` and `@tests` / `@covers`. Only `.ts` files (not `.d.ts`) are taken, whatever else matches; a test file is never an implementation, nor is anything in a `.design` directory.
- `testAdapter`: `node:test` (the default) or `vitest`.
- `review`: how `cage check` treats a contract without a fresh recorded review: `"warn"` (the default), `"require"` or `"off"`.
- `coverage`: how `cage check` treats exported code of a module without `@implements`: `"warn"` (the default), `"require"` or `"off"`.
- `reviewDependencies`: the bounds of the dependency part of review fingerprints (see “`review`”). `depth` 0–10 and `maxFiles` 0–1000 are whole numbers, `exclude` glob patterns; each is optional and the others keep their defaults.
- `maxDiagnostics`: how many diagnostics `check` and `gate` show at most: a whole number from 0 to 10000, or `"all"`. `--max-diagnostics` overrides it for one run.

## Codes

What every diagnostic means and what to do about it; `cage codes` prints the same.

| Code | Means | Then |
| --- | --- | --- |
| `E_CONFIG` | .cage/config.json, .cage/review.json, .cage/lock.json, a .cageignore or a verdicts file is not what cage expects; the message names the field | fix the file |
| `E_ENVIRONMENT` | the tsconfig, a file or a Git revision cannot be read or used | fix the environment; the message says what |
| `E_NO_DESIGNS` | no *.cage.mdx matches the designs patterns | write a design next to its module, or fix the patterns |
| `E_MDX_SYNTAX` | the document does not parse as MDX | fix the document |
| `E_DESIGN_BLOCK_MISSING` | a module's documents have no ts design block | add a ```ts design block with the contracts |
| `E_DESIGN_BLOCK_EMPTY` | a ts design block has no code | declare the contracts in it, or remove it |
| `E_DESIGN_BLOCK_LOCATION` | a ts design block is indented or nested; only top-level unindented blocks count | move it to the top level |
| `E_DESIGN_BLOCK_MARKER` | the design marker is on a block whose language is not ts | make it ```ts design |
| `E_DESIGN_IMPORT` | a block imports something other than types of another design with import type | import type from a *.cage.mdx, or declare an independent shape |
| `E_DESIGN_OUT_OF_SCOPE` | a block imports a design document the designs patterns do not cover | widen the patterns, or do not import it |
| `E_DESIGN_CYCLE` | modules depend on each other in a cycle through @uses or type imports | break the cycle |
| `W_BUSINESS_CONTEXT_MISSING` | a module's documents have no prose; a reviewer judges contracts against business rules | write the purpose and the rules in prose |
| `E_UNSUPPORTED_DECLARATION` | a declaration cage cannot check: not an exported interface or type in a design, a generic or overloaded contract, a default export or abstract class as an implementation, a test without a plain title | declare it in a supported form; the message says which |
| `E_DESCRIPTION_MISSING` | a contract or data type has no @description | add one |
| `E_TAG_FORMAT` | a tag is written wrongly: punctuation after its name, no id or name, text where none goes, a tag given twice | write the tag as the message says |
| `E_TAG_LOCATION` | a tag stands where it does not belong: @implements in a design, a design tag on a field, @extendable on a type alias | move or remove the tag |
| `E_UNKNOWN_TAG` | a tag cage does not know; standard JSDoc tags are allowed | fix the spelling |
| `E_UNSUPPORTED_TAG` | @name or @open, reserved and not supported yet | remove it |
| `E_CONTRACT_DUPLICATE` | two contracts have one name; names are unique across the scope | rename one |
| `E_INVARIANT_DUPLICATE` | two invariants of one contract have one id | rename one |
| `E_REFERENCE_UNKNOWN` | @uses, @implements, @tests, @covers or a verdict names a contract or invariant that does not exist | fix the name |
| `E_REFERENCE_AMBIGUOUS` | a test is tagged for two contracts that both have the invariant @covers names | give the test its own @tests naming one contract |
| `E_NO_CONTRACTS` | the designs declare data types only | mark the interfaces the code implements @contract |
| `W_NO_INVARIANTS` | a contract promises no rule; only its types are checked | write @invariant rules, each with a linked test |
| `E_TYPESCRIPT` | the compiler rejects a ts design block or a file with @implements | fix the type error |
| `W_WEAK_TYPECHECK` | strictNullChecks, strictFunctionTypes or noImplicitAny is off; implementations are compared more loosely | turn them on in tsconfig |
| `E_IMPLEMENTATION_MISSING` | no exported class, function or const is marked @implements for the contract | tag the implementation |
| `E_TYPE_MISMATCH` | the compiler does not accept the implementation where the contract is expected; its explanation follows | fit the implementation to the contract, or change the contract |
| `E_TEST_MISSING` | no test is tagged @covers for the invariant | write or tag a test |
| `E_TEST_INACTIVE` | every test of the invariant is skipped, todo, empty or in a file with a broken import | enable one, give it a body, or fix the import |
| `W_TEST_INACTIVE` | an inactive test covers invariants that other, active tests also cover | enable it or remove it |
| `E_TEST_CONTEXT` | @covers without a contract: no @tests on the test or an enclosing suite | add @tests Name |
| `W_NOT_DESIGNED` | an exported class, function or const of a designed module has no @implements | describe its contract in the design, or list the file in the module's .cageignore |
| `E_NOT_DESIGNED` | the same, as an error under coverage: require | the same |
| `E_LOCK_MISSING` | a declaration is @final or @extendable but not recorded in .cage/lock.json | run cage lock |
| `E_LOCK_VIOLATION` | a locked declaration changed; the changes follow | revert the change, or lift the lock deliberately by removing its record |
| `W_LOCK_UNRECORDED` | an @extendable declaration has additions not recorded yet | run cage lock |
| `W_LOCK_OPEN_TYPE` | a locked declaration uses a type that is not locked; a change there changes it too | mark the type @final or @extendable |
| `E_LOCK_BASE` | a lock recorded at the base revision is gone or weaker here | restore it; a lock the base has is lifted on the base |
| `W_REVIEW_MISSING` | the contract has no recorded review | cage review lists it; cage review <Name>, then cage review --record |
| `E_REVIEW_MISSING` | the same, as an error under review: require | the same |
| `W_REVIEW_STALE` | the material changed since the recorded review or acceptance; the parts follow | cage review <Name>, judge the touched invariants, record the verdict |
| `E_REVIEW_STALE` | the same, as an error under review: require | the same |
| `W_REVIEW_WEAK` | the recorded review found an invariant or the contract weak, unrelated or lacking context | improve the test or the design, then review again; never lower the assessment |
| `E_REVIEW_WEAK` | the same, as an error under review: require | the same |
| `W_REVIEW_SCOPE_LIMIT` | the review fingerprint stops at the bounds of reviewDependencies; a change in the listed files would not outdate the review | nothing for the agent: the bounds are the project's setting |
| `E_REVIEW_SCOPE_LIMIT` | the same, as an error under review: require | a person revisits reviewDependencies |
| `E_REVIEW_VERDICT` | a verdict cannot be recorded: other material, an unknown or unassessed invariant, no reason or evidence | fix the verdicts file; nothing was recorded |
| `W_OUTSIDE_ROOT` | a symbolic link leads out of the project; cage does not read the file | move the file into the project |
| `W_GATE_COMMAND` | a Stop hook mentions cage gate but is not the gate of this project, or no installed cage was found | check the hook command and the installation |

## Implementation notes

- **The project's TypeScript.** The harness loads the `typescript` package from the `node_modules` of the target project's root or a directory above it, when it is version 5.x or 6.x. A copy Node would find through `NODE_PATH` or global directories does not count as the project's. So the tsconfig means to the harness what it means to the project's `tsc`: the default `strict` and `types` differ between TS 5 and TS 6. When there is no package, it cannot be loaded, or it is TypeScript 7 (the native port, without the Compiler API), the bundled 6.0.3 is used. The version, its source and the reason for a fallback are in the `check` report. Tested on 5.9.3 and 6.0.3.
- **The harness never imports `typescript` statically**, only its types: the compiler instance is passed as the `ts` parameter.
- **Project options.** The project's tsconfig is taken, with `extends`. Changed: `noEmit: true`; `rootDir` is ignored, as it only concerns emit; `noCheck` is ignored, as it would turn type checking off; under TypeScript 6 the options it declared deprecated but still honours (`baseUrl`, `moduleResolution: node10`) are accepted without error.
- **TypeScript configuration errors** have the code `E_ENVIRONMENT` and exit 2.
- **Order of layers.** Declaration and tag errors do not stop type checking; only forbidden imports do, because the compiler would repeat them as unresolved modules or read a foreign file from disk. Every statement that names another module is an import: `export … from`, `import x = require(…)`. A `/// <reference>` at the start of a block is checked before the compiler.
- **One mistake, one diagnostic.** Tags inside a rejected declaration are not reported as misplaced; `W_NO_INVARIANTS` is not given when invariants are written but rejected.
- **`E_NO_CONTRACTS`** is reported only when the declarations have no other errors: otherwise it would be their consequence.
- **Codes for rules without a code of their own.** A declaration without a marker, a non-exported declaration and forbidden `@ts-*` comments are `E_UNSUPPORTED_DECLARATION`. `@contract` / `@data` with text after the tag, or both markers at once, are `E_TAG_FORMAT`.
- **Interface merging.** TypeScript silently merges two interfaces with one name. In a design it is an error: two contracts are `E_CONTRACT_DUPLICATE`, otherwise `E_UNSUPPORTED_DECLARATION`.
- **Cycles.** Every group of mutually dependent modules is reported once, by the shortest cycle through its first module.
- **The conformance check.** For every implementation a file is created in memory next to it: type-only imports of the implementation and the contract, and the expression `value satisfies design.Contract`. A compiler error on that expression becomes `E_TYPE_MISMATCH` at the implementation, with the compiler's explanation and a reference to the contract in the MDX. The import specifiers are chosen for the project's module resolution; when none resolves, the harness stops with an error instead of skipping the check. Nothing is written to disk.
- **The program of a full check** holds the files of the project's tsconfig, the virtual design modules from memory, the tagged files and the check files. The project files are needed for global declarations. Parsed files, the TypeScript library among them, are taken from the design phase rather than parsed twice.
- **One mistake, one diagnostic, here too.** A rejected `@implements` does not also give `E_IMPLEMENTATION_MISSING` for its contract; a rejected `@tests` or `@covers` does not give `E_TEST_MISSING` for what it named. When a file could not be parsed, the same holds for the contracts it names after `@implements` or `@tests`. The exception: `@tests` with the name of a contract that does not exist leaves `E_TEST_MISSING`, because it is unknown which contract was meant.
- **A file that cannot be read** (permissions) gives `E_ENVIRONMENT` in the report and exit 2, not a crash.
- **Compiler texts** in the report have no absolute paths: the project's path is stripped.
- **Which files are read.** Of the candidates matched by `implementations` and `tests`, only those whose text contains a binding tag.
- **Test recognition** goes through the compiler's symbols, so shadowing and aliases are handled without a scope analysis of our own.
- **Errors in a design stop the full check** at the design phase: there is no sense in comparing implementations with a contract that has errors itself.
- **Signatures for locks** are printed by the compiler's printer, so the record does not depend on how a block is formatted.
- **The tag parser** is our own and textual: TypeScript only gives the position of the JSDoc comment before a declaration. So `@implements` does not depend on how the compiler treats it.
- **Mapping.** Every copied line of a block is one segment `offset in the virtual module → offset in the document`. The end of the text maps to the end of the last authored line.
- **A BOM** at the start of a `*.cage.mdx` is dropped on reading; columns are counted without it.
- **The position of an MDX error** is taken from `place`; for a tag left unclosed to the end of the document the parser gives it only in the message text.
- **Paths to the TypeScript library** in reports look like `typescript/lib/lib.*.d.ts`.
- **File discovery** is our own directory walk with `path.matchesGlob`, only where a pattern can match.
- **Writing** goes to a temporary file next to the target and `rename`. Comparison with the disk ignores CRLF/LF and BOM differences.
- **Tests** copy a fixture into `test/.tmp/` inside the repository, so that the copy finds `@types/node`. The fixture `test/fixtures/vertical` holds three MDX documents, a `package.json` and a `tsconfig.json`. TypeScript 5.9.3 is installed under the name `typescript-5` for the tests only; so the build scripts call `node_modules/typescript/bin/tsc` explicitly.

- **Whether an imported name exists at run time** is decided by (module, name), the way the module's statements pass the name on: a declaration in the module must carry a value flag; `export { x } from`, `import { x }` and defaults lead to the other module's export (`getExportSpecifierLocalTargetSymbol` for `export { x }` of a local name); a name reached only through stars is a value when a star that is not `export type *` leads to a value; `export type * as ns`, `import type`, `{ type x }` and `export type { x }` make it a type. `getImmediateAliasedSymbol` is the fallback for the rest; a cycle counts as a value.
- **The root boundary** compares `fs.realpathSync` of the file with that of the root, so that links are followed without reading anything; it is applied where review material is read, not to the compiler's own reading of the program.
- **Hook commands are parsed, not matched**: a small shell-word reader (quotes, backslashes, `$CLAUDE_PROJECT_DIR` and `${CLAUDE_PROJECT_DIR}`) that gives up on anything else a shell would act on, and a one-line TOML string reader for the Codex config.
- **Broken imports of test files** are found with the compiler's module resolution and `getExportsOfModule` of the file an import resolves to, only for files that hold test declarations; no test file is type-checked as a whole, so that what the compiler would say about the rest of a test is still the project's `tsc`'s to say.
- **Status marks without colour.** The marks of `review` are plain Unicode characters, the same in a terminal and in a pipe: the packet is read by people and models alike, and there is no ANSI to strip or to break when it is saved to a file.
- **The question of `init`** reads lines synchronously from fd 0 without opening `process.stdin`, so the descriptor stays blocking and `runCli` stays synchronous; the tests give the answers through `CliIo.ask`. Cancelling exits 130, the shell's code for an interrupted command.
- **The limit on diagnostics is applied when the report is printed**, not when it is made: `runCheck` returns everything, `limitCheckReport` picks what is shown (rank, then the report's order) and fills `omitted`, and the exit code is taken from the full report. The gate counts what blocks over the full report and prints the limited one. The default of 50 is a guess at what an agent reads without losing the thread; `init` writes it into the configuration so that it is in view.
- **Excerpts are computed next to the digests, not instead of them.** The text of an implementation or test part is what it was (the digests of recorded reviews do not change); `materialAt` now also returns the line ranges the pieces of that text came from, and `--files changed` prints those lines of the file. A changed design or dependency has no smaller part and comes whole. A test part that is gone touches every invariant: the record holds its digest, not what it covered. The fingerprint hashes the parts in order, so reordering tests in a file outdates a review while every digest still matches; such a record is shown as not matching, with everything included, rather than as "nothing changed" — making the fingerprint order-insensitive would outdate every recorded review once more.
- **A packet of a contract whose review file is unusable** now carries that `E_CONFIG` and exits 2, as the index and `check` do; before, the packet showed the status as not known and exited 0.
- **cage checks itself.** `src/cage.cage.mdx` declares the ports (`Cli`, `ConfigLoader`, `Codes`) with the rules of the README as invariants; `src/.cageignore` lists everything behind them. The check runs with the published package pinned as `cage-stable` (an npm alias: npm refuses `ENOSELF`, a dependency on the package's own name), so a broken working tree cannot break its own gate; `reviewDependencies` is widened so that every file the ports import, however deep, is in their fingerprints — all of `src/` but `cli.ts`, which nothing imports: a change there outdates no review, and it holds only the process wiring.
- **Diagnostics are facts, the legend is one place.** A message names the thing (`Quota.consume`, `` `@covers refund` ``, `class Extra in src/mail`) and nothing else; what a code means and what to do is `CODES` in `src/codes.ts`, printed by `cage codes` and copied into the table above (a test holds the two together and checks that every code the source emits is in the table). The agent reads reports by the hundred; a sentence repeated a hundred times is noise, and the advice that used to sit in `REVIEW_SCOPE_LIMIT` sent agents to edit the configuration.
- **An acceptance is an entry of the review file** with `"accepted": true` and `findings: []` — the same fingerprint and digests as a verdict, so that `check` tells staleness the same way, and no finding, so that nothing reads as a judgement. A file with `accepted` and findings together is not usable (`E_CONFIG`). Review files written before have no `accepted` key and read as before.
- **Review material is cut from the texts the check read.** The implementation phase keeps the implementation and test files it read (`linking.sources`), and the review's file reader takes them from there, not from the disk again: the locations of implementations, tests and hooks are positions in those texts. Before, a file edited between the two reads — by an agent working in the project while `cage review` ran — made a location point past the end of its line, and the compiler's `getPositionOfLineAndCharacter` failed with `Debug Failure. False expression.` Dependency files are still read from the disk once, when the fingerprint is taken: no location points into them.

## Not there yet

- Shorter compiler explanations in `E_TYPE_MISMATCH`: sometimes a dozen lines of which one matters.
- A line starting with `@word` inside a code example in JSDoc (`@example`) is read as a tag.
- Jest is not recognised: adapters exist only for `node:test` and Vitest.
- No execution evidence: cage does not run tests or read a runner's report (JUnit and the like), so “linked and active” never means “passed”. CI runs the tests as a step of its own.
- No reviewer provenance: a recorded verdict does not say who or what made it, and nothing requires the reviewer to differ from the author.
- The harness has not been run on Windows.
