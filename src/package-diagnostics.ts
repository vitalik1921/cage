import type ts from "typescript";
import type { Overlay, TypeScript } from "./typescript.ts";

/** Declaration nodes selected by a design's imports, grouped by their compiler file name. */
export interface PackageDiagnosticSelection {
  declarations: ReadonlyMap<string, readonly ts.Node[]>;
}

export interface PackageDiagnostics {
  /** Compiler errors inside selected declarations, with compiler suppression directives already applied. */
  diagnosticsFor(selection: PackageDiagnosticSelection): ts.Diagnostic[];
  /** Whether the compiler reports an error starting at an unresolved reference's syntax. */
  hasErrorAt(fileName: string, start: number, end: number): boolean;
}

/**
 * Check selected declarations with the project's compiler options, including skipLibCheck. Syntax errors remain
 * errors, as in tsc. Only unresolved selected references need a companion with library checking enabled: skipping
 * a library's type errors must not silently replace a missing dependency with any. Effective suppressions still apply.
 * The companion reuses the overlay and parsed files; semantic diagnostics are cached per file and resolver run.
 */
export function createPackageDiagnostics(ts: TypeScript, overlay: Pick<Overlay, "createProgram">, program: ts.Program): PackageDiagnostics {
  let checkingProgram: ts.Program | undefined;
  const cached = new Map<string, readonly ts.Diagnostic[]>();
  const reportedErrors = (fileName: string): readonly ts.Diagnostic[] => {
    const known = cached.get(fileName);
    if (known) return known;
    checkingProgram ??= program.getCompilerOptions().skipLibCheck
      ? overlay.createProgram(program.getRootFileNames(), {
          options: { ...program.getCompilerOptions(), skipLibCheck: false },
          oldProgram: program,
        })
      : program;
    const sourceFile = checkingProgram.getSourceFile(fileName);
    const errors = sourceFile
      ? [...checkingProgram.getSyntacticDiagnostics(sourceFile), ...checkingProgram.getSemanticDiagnostics(sourceFile)]
          .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      : [];
    cached.set(fileName, errors);
    return errors;
  };

  return {
    diagnosticsFor(selection) {
      const selected: ts.Diagnostic[] = [];
      for (const [fileName, declarations] of selection.declarations) {
        if (!declarations.length) continue;
        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) continue;
        const errors = sourceFile.isDeclarationFile && program.getCompilerOptions().skipLibCheck
          ? program.getSyntacticDiagnostics(sourceFile).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
          : reportedErrors(fileName);
        for (const diagnostic of errors) {
          // An unused @ts-expect-error (TS2578) does not alter the imported shape. A compiler error
          // without a position cannot be assigned to a smaller declaration, so charge it to this file.
          if (diagnostic.code === 2578) continue;
          if (diagnostic.start === undefined) {
            selected.push(diagnostic);
            continue;
          }
          // Recovery can place a missing closing token at EOF, just beyond the selected node's end.
          // Trailing whitespace/comments are not part of that node; neither may hide an unfinished declaration.
          const atEnd = diagnostic.start === sourceFile.end;
          if (declarations.some((node) => diagnostic.start! >= node.getStart(sourceFile) &&
            (diagnostic.start! < node.getEnd() || (atEnd && ts.createScanner(ts.ScriptTarget.Latest, true,
              sourceFile.languageVariant, sourceFile.text.slice(node.getEnd())).scan() === ts.SyntaxKind.EndOfFileToken)))) selected.push(diagnostic);
        }
      }
      return selected;
    },
    hasErrorAt(fileName, start, end) {
      return reportedErrors(fileName).some((diagnostic) =>
        diagnostic.code !== 2578 && diagnostic.start !== undefined && diagnostic.start >= start && diagnostic.start < end);
    },
  };
}
