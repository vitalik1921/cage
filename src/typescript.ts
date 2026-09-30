import path from "node:path";
import ts from "typescript";

export interface CompilerSetup {
  options: ts.CompilerOptions;
  errors: readonly ts.Diagnostic[];
}

/**
 * Reads the project tsconfig (with `extends`). Only two things are overridden.
 * Emit is switched off, and with it `rootDir`, which only lays out emitted
 * files but rejects any design that lives outside it. And options that the
 * bundled TypeScript 6 deprecates but still honours (`baseUrl`,
 * `moduleResolution: node10`, ...) are accepted, because a project compiled
 * with TypeScript 5 uses them legitimately.
 */
export function readCompilerOptions(tsconfigFile: string): CompilerSetup {
  const unrecoverable: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigFile, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => unrecoverable.push(diagnostic),
  });
  if (!parsed) return { options: {}, errors: unrecoverable };
  // TS18003 "No inputs were found": program roots are passed explicitly, not taken from `include`.
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  return { options: { ...parsed.options, noEmit: true, rootDir: undefined, ignoreDeprecations: "6.0" }, errors };
}

/** Parses files on their own: no library, no module resolution, no type information. */
export const syntaxOnlyOptions: ts.CompilerOptions = { noLib: true, noResolve: true, noEmit: true, types: [] };

/**
 * A program whose roots are the `overlay` texts, served in place of the disk:
 * the files need not exist, and a stale file on disk is never read instead of
 * them. File existence, reads and module resolution all go through the overlay.
 */
export function createOverlayProgram(options: ts.CompilerOptions, overlay: ReadonlyMap<string, string>): ts.Program {
  const base = ts.createCompilerHost(options, true);
  const key = (fileName: string) => base.getCanonicalFileName(path.resolve(fileName));
  const files = new Map([...overlay].map(([fileName, text]) => [key(fileName), text]));
  const overlayText = (fileName: string) => files.get(key(fileName));

  const host: ts.CompilerHost = {
    ...base,
    fileExists: (fileName) => overlayText(fileName) !== undefined || base.fileExists(fileName),
    readFile: (fileName) => overlayText(fileName) ?? base.readFile(fileName),
    realpath: (fileName) => (overlayText(fileName) !== undefined ? fileName : (base.realpath?.(fileName) ?? fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = overlayText(fileName);
      return text === undefined
        ? base.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, text, languageVersion, true);
    },
  };
  return ts.createProgram({ rootNames: [...overlay.keys()], options, host });
}

export function requireSourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`${fileName} is missing from the TypeScript program.`);
  return sourceFile;
}

/**
 * Offsets of `// @ts-nocheck` pragmas. The compiler honours the pragma in the
 * comments before the first token of a file and then reports no type errors.
 */
export function findNoCheckPragmas(text: string): number[] {
  return (ts.getLeadingCommentRanges(text, 0) ?? [])
    .filter((range) => /^\/\/\/?\s*@ts-nocheck(?=[\s:]|$)/.test(text.slice(range.pos, range.end)))
    .map((range) => range.pos);
}
