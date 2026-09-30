/** A position in an authored file: project-relative POSIX path, 1-based line and UTF-16 column. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
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
  location: SourceLocation;
}

export interface DataType {
  name: string;
  module: string;
  description: string | null;
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
}

export const emptyIndex = (): DesignIndex => ({ contracts: [], data: [], invariants: [], edges: [] });
