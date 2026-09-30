import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type ts from "typescript";

/** The compiler API. Always the loaded instance, never a static import: see `loadTypeScript`. */
export type TypeScript = typeof ts;

export interface TypeScriptInfo {
  version: string;
  /** "project": the `typescript` package the project resolves; "bundled": the one installed with the harness. */
  source: "project" | "bundled";
  /** Why the project's own TypeScript is not used, when it has one. */
  fallbackReason?: string;
}

/**
 * Loads the compiler the project itself uses, so that its tsconfig means the
 * same here as for the project's `tsc`: defaults such as `strict` and `types`
 * differ between major versions. TypeScript 5 and 6 are supported. Anything
 * else (none installed, one that fails to load, or TypeScript 7, which has no
 * compiler API) falls back to the bundled version.
 *
 * The project's TypeScript is the one in `node_modules` of the project root
 * or of a directory above it. A copy that Node would also find through
 * `NODE_PATH` or a global folder is not the project's.
 */
export function loadTypeScript(root: string): { ts: TypeScript; info: TypeScriptInfo } {
  const require = createRequire(path.join(root, "package.json"));
  let fallbackReason: string | undefined;
  if (isInstalledIn(root, require)) {
    try {
      const candidate = require("typescript") as Partial<TypeScript>;
      const version = typeof candidate.version === "string" ? candidate.version : "of an unknown version";
      if (typeof candidate.createProgram === "function" && /^[56]\./.test(version)) {
        return { ts: candidate as TypeScript, info: { version, source: "project" } };
      }
      fallbackReason = `the project's TypeScript ${version} has no usable compiler API`;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
      fallbackReason = `the project's TypeScript cannot be loaded: ${message}`;
    }
  }
  const bundled = createRequire(import.meta.url)("typescript") as TypeScript;
  return { ts: bundled, info: { version: bundled.version, source: "bundled", ...(fallbackReason === undefined ? {} : { fallbackReason }) } };
}

/** Whether a `typescript` package sits in `node_modules` of `root` or of one of its ancestors. */
function isInstalledIn(root: string, require: NodeJS.Require): boolean {
  let manifest: string;
  try {
    manifest = require.resolve("typescript/package.json");
  } catch (cause) {
    // Not found at all; any other failure means a package is there, and loading it will say what is wrong.
    if ((cause as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return false;
    return true;
  }
  // `require.resolve` answers with real paths, so compare with the real path of the root.
  for (let directory = fs.realpathSync(root); ; directory = path.dirname(directory)) {
    if (manifest.startsWith(path.join(directory, "node_modules") + path.sep)) return true;
    if (directory === path.dirname(directory)) return false;
  }
}

export interface CompilerSetup {
  options: ts.CompilerOptions;
  errors: readonly ts.Diagnostic[];
}

/**
 * Reads the project tsconfig (with `extends`). Emit is switched off, and with
 * it `rootDir`, which only lays out emitted files but rejects any design that
 * lives outside it. `noCheck`, meant for fast emit, would switch the type
 * check off, so it is dropped. TypeScript 6 also accepts the options it
 * deprecates but still honours (`baseUrl`, `moduleResolution: node10`, ...):
 * that matters when the bundled compiler checks a project written for
 * TypeScript 5.
 */
export function readCompilerOptions(ts: TypeScript, tsconfigFile: string): CompilerSetup {
  const unrecoverable: ts.Diagnostic[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigFile, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => unrecoverable.push(diagnostic),
  });
  if (!parsed) return { options: {}, errors: unrecoverable };
  // TS18003 "No inputs were found": program roots are passed explicitly, not taken from `include`.
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, rootDir: undefined, noCheck: undefined };
  if (ts.versionMajorMinor.startsWith("6.")) options.ignoreDeprecations = "6.0";
  return { options, errors };
}

/** Parses files on their own: no library, no module resolution, no type information. */
export const syntaxOnlyOptions: ts.CompilerOptions = { noLib: true, noResolve: true, noEmit: true, types: [] };

export interface OverlayProgram {
  program: ts.Program;
  /** Resolves a module specifier the way the program does; undefined when it does not resolve. */
  resolveModule: (specifier: ts.StringLiteralLike, from: ts.SourceFile) => string | undefined;
  /** Whether two paths name the same file for this program. */
  sameFile: (a: string, b: string) => boolean;
}

/**
 * A program whose roots are the `overlay` texts, served in place of the disk:
 * the files need not exist, and a stale file on disk is never read instead of
 * them. File existence, reads and module resolution all go through the overlay.
 */
export function createOverlayProgram(ts: TypeScript, options: ts.CompilerOptions, overlay: ReadonlyMap<string, string>): OverlayProgram {
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
  return {
    program: ts.createProgram({ rootNames: [...overlay.keys()], options, host }),
    resolveModule: (specifier, from) =>
      ts.resolveModuleName(specifier.text, from.fileName, options, host, undefined, undefined, ts.getModeForUsageLocation(from, specifier, options))
        .resolvedModule?.resolvedFileName,
    sameFile: (a, b) => key(a) === key(b),
  };
}

export function requireSourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`${fileName} is missing from the TypeScript program.`);
  return sourceFile;
}
