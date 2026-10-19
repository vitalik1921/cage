export type Severity = "error" | "warning";

export interface RelatedLocation {
  message: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * Locations are project-relative POSIX paths with 1-based line/column;
 * columns count UTF-16 code units. A diagnostic without `line` refers to the
 * whole file (or to nothing, without `file`).
 */
export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** Original TypeScript code for E_TYPESCRIPT / E_ENVIRONMENT diagnostics. */
  tsCode?: number;
  /** The contract, and its invariant, that the diagnostic is about. */
  contract?: string;
  invariant?: string;
  related?: RelatedLocation[];
  /** Structured review evidence for compact gate feedback; message retains the full check explanation. */
  review?: {
    changes?: { part: string; change: "changed" | "new" | "gone" }[];
    finding?: { assessment: string; reason: string };
  };
  /**
   * A cause the checker proved from declarations, not from text: diagnostics of one code and severity with the same
   * `id` share it, and human output prints `summary` once, then each `subject` (the member or implementation) with
   * its `contracts`, whose places are `related` in the same order. Ids are opaque and comparable within one run only.
   */
  cause?: { id: string; summary: string; subject: string; contracts: string[] };
}

export const isError = (diagnostic: Diagnostic) => diagnostic.severity === "error";

export const hasErrors = (diagnostics: readonly Diagnostic[]) => diagnostics.some(isError);

export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compareText(a.file ?? "", b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareText(a.code, b.code)
  );
}
