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
  related?: RelatedLocation[];
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  return (
    compareText(a.file ?? "", b.file ?? "") ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.column ?? 0) - (b.column ?? 0) ||
    compareText(a.code, b.code)
  );
}
