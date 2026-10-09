/**
 * What every diagnostic code means and what to do about it: the text the diagnostics themselves do not carry. A
 * diagnostic names the thing and the place; this is the one place that explains. `cage codes` prints it.
 */
export const CODES: Record<string, { means: string; then: string }> = {
  // Configuration and environment: exit 2, nothing further is checked.
  E_CONFIG: { means: ".cage/config.json, .cage/review.json, .cage/lock.json, a .cageignore or a verdicts file is not what cage expects; the message names the field", then: "fix the file" },
  E_ENVIRONMENT: { means: "the tsconfig, a file or a Git revision cannot be read or used", then: "fix the environment; the message says what" },
  E_NO_DESIGNS: { means: "no *.cage.mdx matches the designs patterns", then: "write a design next to its module, or fix the patterns" },
  // Design documents.
  E_MDX_SYNTAX: { means: "the document does not parse as MDX", then: "fix the document" },
  E_DESIGN_BLOCK_MISSING: { means: "a module's documents have no ts design block", then: "add a ```ts design block with the contracts" },
  E_DESIGN_BLOCK_EMPTY: { means: "a ts design block has no code", then: "declare the contracts in it, or remove it" },
  E_DESIGN_BLOCK_LOCATION: { means: "a ts design block is indented or nested; only top-level unindented blocks count", then: "move it to the top level" },
  E_DESIGN_BLOCK_MARKER: { means: "the design marker is on a block whose language is not ts", then: "make it ```ts design" },
  E_DESIGN_IMPORT: { means: "a block imports something other than types of another design with import type", then: "import type from a *.cage.mdx, or declare an independent shape" },
  E_DESIGN_OUT_OF_SCOPE: { means: "a block imports a design document the designs patterns do not cover", then: "widen the patterns, or do not import it" },
  E_DESIGN_CYCLE: { means: "modules depend on each other in a cycle through @uses or type imports", then: "break the cycle" },
  W_BUSINESS_CONTEXT_MISSING: { means: "a module's documents have no prose; a reviewer judges contracts against business rules", then: "write the purpose and the rules in prose" },
  // Declarations and tags.
  E_UNSUPPORTED_DECLARATION: { means: "a declaration cage cannot check: not an exported interface or type in a design, a generic or overloaded contract, a default export or abstract class as an implementation, a test without a plain title", then: "declare it in a supported form; the message says which" },
  E_DESCRIPTION_MISSING: { means: "a contract or data type has no @description", then: "add one" },
  E_TAG_FORMAT: { means: "a tag is written wrongly: punctuation after its name, no id or name, text where none goes, a tag given twice", then: "write the tag as the message says" },
  E_TAG_LOCATION: { means: "a tag stands where it does not belong: @implements in a design, a design tag on a field, @extendable on a type alias", then: "move or remove the tag" },
  E_UNKNOWN_TAG: { means: "a tag cage does not know; standard JSDoc tags are allowed", then: "fix the spelling" },
  E_UNSUPPORTED_TAG: { means: "@name or @open, reserved and not supported yet", then: "remove it" },
  E_CONTRACT_DUPLICATE: { means: "two contracts have one name; names are unique across the scope", then: "rename one" },
  E_INVARIANT_DUPLICATE: { means: "two invariants of one contract have one id", then: "rename one" },
  E_REFERENCE_UNKNOWN: { means: "@uses, @implements, @tests, @covers or a verdict names a contract or invariant that does not exist", then: "fix the name" },
  E_REFERENCE_AMBIGUOUS: { means: "a test is tagged for two contracts that both have the invariant @covers names", then: "give the test its own @tests naming one contract" },
  E_NO_CONTRACTS: { means: "the designs declare data types only", then: "mark the interfaces the code implements @contract" },
  W_NO_INVARIANTS: { means: "a contract promises no rule; only its types are checked", then: "write @invariant rules, each with a linked test" },
  // Types.
  E_TYPESCRIPT: { means: "the compiler rejects a ts design block or a file with @implements", then: "fix the type error" },
  W_WEAK_TYPECHECK: { means: "strictNullChecks, strictFunctionTypes or noImplicitAny is off; implementations are compared more loosely", then: "turn them on in tsconfig" },
  // Implementations.
  E_IMPLEMENTATION_MISSING: { means: "no exported class, function or const is marked @implements for the contract", then: "tag the implementation" },
  E_TYPE_MISMATCH: { means: "the compiler does not accept the implementation where the contract is expected; its explanation follows", then: "fit the implementation to the contract, or change the contract" },
  // Tests.
  E_TEST_MISSING: { means: "no test is tagged @covers for the invariant", then: "write or tag a test" },
  E_TEST_INACTIVE: { means: "every test of the invariant is skipped, todo, empty or in a file with a broken import", then: "enable one, give it a body, or fix the import" },
  W_TEST_INACTIVE: { means: "an inactive test covers invariants that other, active tests also cover", then: "enable it or remove it" },
  E_TEST_CONTEXT: { means: "@covers without a contract: no @tests on the test or an enclosing suite", then: "add @tests Name" },
  // Coverage.
  W_NOT_DESIGNED: { means: "an exported class, function or const of a designed module has no @implements", then: "describe its contract in the design, or list the file in the module's .cageignore" },
  E_NOT_DESIGNED: { means: "the same, as an error under coverage: require", then: "the same" },
  // Locks.
  E_LOCK_MISSING: { means: "a declaration is @final or @extendable but not recorded in .cage/lock.json", then: "run cage lock" },
  E_LOCK_VIOLATION: { means: "a locked declaration changed; the changes follow", then: "revert the change, or lift the lock deliberately by removing its record" },
  W_LOCK_UNRECORDED: { means: "an @extendable declaration has additions not recorded yet", then: "run cage lock" },
  W_LOCK_OPEN_TYPE: { means: "a locked declaration uses a type that is not locked; a change there changes it too", then: "mark the type @final or @extendable" },
  E_LOCK_BASE: { means: "a lock recorded at the base revision is gone or weaker here", then: "restore it; a lock the base has is lifted on the base" },
  // Reviews.
  W_REVIEW_MISSING: { means: "the contract has no recorded review", then: "cage review lists it; cage review <Name>, then cage review --record" },
  E_REVIEW_MISSING: { means: "the same, as an error under review: require", then: "the same" },
  W_REVIEW_STALE: { means: "the material changed since the recorded review or acceptance; the parts follow", then: "cage review <Name>, judge the touched invariants, record the verdict" },
  E_REVIEW_STALE: { means: "the same, as an error under review: require", then: "the same" },
  W_REVIEW_WEAK: { means: "the recorded review found an invariant or the contract weak, unrelated or lacking context", then: "improve the test or the design, then review again; never lower the assessment" },
  E_REVIEW_WEAK: { means: "the same, as an error under review: require", then: "the same" },
  E_REVIEW_VERDICT: { means: "a verdict cannot be recorded: other material, an unknown or unassessed invariant, no reason or evidence", then: "fix the verdicts file; nothing was recorded" },
  W_OUTSIDE_ROOT: { means: "a symbolic link leads out of the project; cage does not read the file", then: "move the file into the project" },
  // Agent setup.
  W_GATE_COMMAND: { means: "a Stop hook mentions cage gate but is not the gate of this project, or no installed cage was found", then: "check the hook command and the installation" },
};

/**
 * The legend, one line per code: what it means; what to do.
 * @implements Codes
 */
export function formatCodes(): string {
  const width = Math.max(...Object.keys(CODES).map((code) => code.length));
  return `${Object.entries(CODES)
    .map(([code, { means, then }]) => `${code.padEnd(width)}  ${means}. Then: ${then}.`)
    .join("\n")}\n`;
}
