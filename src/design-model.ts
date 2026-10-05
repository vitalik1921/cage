/** A position in an authored file: project-relative POSIX path, 1-based line and UTF-16 column. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

/** "final": the declaration never changes. "extendable": what it has never changes, more may be added. */
export type LockLevel = "final" | "extendable";

/** A declaration marked `@final` or `@extendable`, with what the lock covers in a form that ignores formatting and comments. */
export interface LockedDeclaration {
  name: string;
  module: string;
  kind: "contract" | "data";
  level: LockLevel;
  /** Member name to its signature; keys that start with ":" are for what has no name, such as ":call" and ":type". */
  members: Record<string, string>;
  /** Invariant id to its text, for a contract: what it promises is locked with its signatures. Empty for a data type. */
  invariants: Record<string, string>;
  location: SourceLocation;
}

export interface ContractMember {
  name: string;
  description: string | null;
  location: SourceLocation;
}

export interface Contract {
  name: string;
  /** Module ID: the project-relative path of the module root. */
  module: string;
  description: string | null;
  /** An interface with methods, or an interface with a single call signature. */
  shape: "object" | "callable";
  /** Methods of an object contract, in declaration order. */
  members: ContractMember[];
  /** Null when the contract is open to any change. */
  lock: LockLevel | null;
  location: SourceLocation;
  /** The declaration as written, with its doc comment: what a review of the contract is about. */
  source: string;
}

export interface DataType {
  name: string;
  module: string;
  description: string | null;
  lock: LockLevel | null;
  location: SourceLocation;
}

export interface Invariant {
  contract: string;
  id: string;
  text: string;
  /** The method it is declared on, or null for the contract as a whole. */
  member: string | null;
  location: SourceLocation;
}

export interface Implementation {
  contract: string;
  /** The exported name of the class, function or const. */
  name: string;
  kind: "class" | "function" | "const";
  /** Whether the compiler accepts it where the contract is expected. */
  compatible: boolean;
  location: SourceLocation;
}

/**
 * Whether a declaration would run an assertion, as far as its text shows: `skipped` and `todo` by its own
 * modifier or options or by an enclosing suite's, `empty` when it has no callback or one with an empty
 * block. Structural only: an `active` test may still assert nothing, and a runner may skip it at run time.
 */
/**
 * What a test declaration's text shows about whether it can run an assertion: `broken-import` when its file
 * imports a project file that resolves to nothing, or a name that file does not export. The compiler rejects
 * such a file and Node does not load it as an ES module; the declaration cannot be relied on to run.
 */
export type TestStatus = "active" | "skipped" | "todo" | "empty" | "broken-import";

/** A test declaration inside a `@tests` suite. It says that a test was declared, not that it ran or passed. */
export interface TestDeclaration {
  title: string;
  /** Titles of the enclosing suites, outermost first. */
  suitePath: string[];
  adapter: "node:test" | "vitest";
  /** The contract named by `@tests` on the test itself or on the nearest suite that has one. */
  contract: string;
  /** Invariant ids of that contract named by `@covers`. */
  covers: string[];
  status: TestStatus;
  /** Why it is not active, in words: "skipped by its suite \"Quota\"", "has an empty body". Absent when active. */
  inactiveBecause?: string;
  /**
   * The runner hooks that set the test up, as statements of its file: those at the file's top level and
   * those of its enclosing suites, recognised by their binding to the runner like declarations are.
   */
  setup: SourceLocation[];
  location: SourceLocation;
}

/**
 * A declared dependency. `uses` connects contracts by name; `type-import`
 * connects modules: the importing design and the design whose types it imports.
 */
export type Edge =
  | { kind: "uses"; from: string; to: string; fromModule: string; toModule: string; location: SourceLocation }
  | { kind: "type-import"; fromModule: string; toModule: string; location: SourceLocation };

export interface DesignIndex {
  contracts: Contract[];
  data: DataType[];
  invariants: Invariant[];
  edges: Edge[];
  locked: LockedDeclaration[];
}

export const emptyIndex = (): DesignIndex => ({ contracts: [], data: [], invariants: [], edges: [], locked: [] });
