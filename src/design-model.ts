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
  /**
   * Where an inherited member is declared: a `@contract` or `@data` declaration of a design, or a package's
   * declaration (`module` is then the package name). Absent for a member of the contract's own body, including
   * one it redeclares.
   */
  inheritedFrom?: { name: string; module: string; kind: "contract" | "data" | "package" | "project" };
}

export interface Contract {
  /** Abstract invariant-bearing base; concrete contracts extend it and have separate implementations and reviews. */
  family?: true;
  name: string;
  /** Module ID: the project-relative path of the module root. */
  module: string;
  description: string | null;
  /** An interface with methods/properties, or an interface with a single call signature. */
  shape: "object" | "callable";
  /** Named members of an object contract, in declaration order. */
  members: ContractMember[];
  /** Null when the contract is open to any change. */
  lock: LockLevel | null;
  location: SourceLocation;
  /**
   * The declaration as written, with its doc comment: what a review of the contract is about. For a contract that
   * extends design declarations, followed by each of its bases, transitively and once each: an edit to a base edits it.
   */
  source: string;
  /** What it extends directly, in the order of its `extends` clause; `module` of a package's declaration is the package name. */
  bases?: { name: string; module: string; kind: "contract" | "data" | "package" | "project" }[];
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
  /** The named member it is declared on, or null for the contract as a whole. */
  member: string | null;
  /** Where it is declared: the base contract it is inherited from; absent when the contract declares it itself. */
  inheritedFrom?: { contract: string; module: string };
  location: SourceLocation;
}

export interface Implementation {
  contract: string;
  /** The exported name of the class, function or const. */
  name: string;
  kind: "class" | "function" | "const";
  /** Whether compiler assignability and exact public conformance both pass. */
  compatible: boolean;
  /** Present only for an explicit static-side class contract. */
  surface?: "static";
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
 * connects modules: the importing design and the design whose types it imports;
 * `extends` connects a contract to a design declaration it extends directly.
 */
export type Edge =
  | { kind: "uses"; from: string; to: string; fromModule: string; toModule: string; location: SourceLocation }
  | { kind: "type-import"; fromModule: string; toModule: string; location: SourceLocation }
  | { kind: "extends"; from: string; to: string; toKind: "contract" | "data"; fromModule: string; toModule: string; location: SourceLocation };

/** A declaration file of an installed package, named by the package and its path in it, never by where it is installed. */
export interface PackageTypesFile {
  /** `name@version/path`: `zod@3.23.8/lib/types.d.ts`. */
  id: string;
  /** The file's real path from the project root; it may lead into a `node_modules` above the root. */
  file: string;
  /** Of the file's tokens and reference directives: comments and layout do not count. */
  digest: string;
  /** Resolved references from this declaration, with their specifiers and targets; sorted for stable fingerprints. */
  routing: string[];
  /** The file as the compiler read it, line endings normalized: what a reviewer reads. */
  text: string;
}

/** An `import type` of an installed package's declarations in a design. Packages are types only: nothing of them is executed. */
export interface PackageImport {
  /** Explicit project vocabulary uses the same material/lock transport, without pretending to be an installed package. */
  origin?: "project";
  /** The importing design. */
  module: string;
  /** As the document writes it: `zod`, `zod/v4`. */
  specifier: string;
  /** The installed package, by its package.json: `zod`, or `@types/express` for DefinitelyTyped. */
  name: string;
  version: string;
  /** The package's real directory from the project root. */
  directory: string;
  /** The declaration file selected by the compiler for this import, as `name@version/path`. */
  resolution: string;
  /** The physical entry declaration path, to distinguish copies with the same package name and version. */
  resolutionFile: string;
  /** What the design names: the imported names, `default`, the members named through a namespace import. Sorted. */
  names: string[];
  /**
   * The declaration files the specifier's types can reach, its own and those of other packages, sorted by id: every
   * file a module specifier, a reference directive or a name in them resolves to, ambient modules and globals among
   * them; the compiler's default library is the only boundary.
   */
  files: PackageTypesFile[];
  /** The declarations of `names`, for a reviewer; filled after the type check, empty when it did not run. */
  declarations: { name: string; id: string; line: number; text: string }[];
  location: SourceLocation;
}

export interface DesignIndex {
  contracts: Contract[];
  data: DataType[];
  invariants: Invariant[];
  edges: Edge[];
  locked: LockedDeclaration[];
  /** One entry per design and package specifier. */
  packages: PackageImport[];
}

export const emptyIndex = (): DesignIndex => ({ contracts: [], data: [], invariants: [], edges: [], locked: [], packages: [] });
