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
  /** The files of the project: what its tsconfig includes. */
  fileNames: string[];
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
  if (!parsed) return { options: {}, fileNames: [], errors: unrecoverable };
  // TS18003 "No inputs were found": program roots are passed explicitly, not taken from `include`.
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true, rootDir: undefined, noCheck: undefined };
  if (ts.versionMajorMinor.startsWith("6.")) options.ignoreDeprecations = "6.0";
  return { options, fileNames: parsed.fileNames, errors };
}

/** The three options that decide how much a comparison of types is worth. */
export interface StrictOptions {
  strictNullChecks: boolean;
  strictFunctionTypes: boolean;
  noImplicitAny: boolean;
}

/** The effective values: given explicitly, or through `strict`, which TypeScript 6 turns on by default. */
export function readStrictOptions(ts: TypeScript, options: ts.CompilerOptions): StrictOptions {
  const on = (value: boolean | undefined) => value ?? options.strict ?? !ts.versionMajorMinor.startsWith("5.");
  return { strictNullChecks: on(options.strictNullChecks), strictFunctionTypes: on(options.strictFunctionTypes), noImplicitAny: on(options.noImplicitAny) };
}

/** Parses files on their own: no library, no module resolution, no type information. */
export const syntaxOnlyOptions: ts.CompilerOptions = { noLib: true, noResolve: true, noEmit: true, types: [] };

export interface Overlay {
  /** Adds in-memory files; they take part in programs created afterwards. */
  add(files: ReadonlyMap<string, string>): void;
  /** A program with the given roots; nothing is emitted. Files parsed for an earlier program of this overlay are reused. */
  createProgram(rootNames: readonly string[]): ts.Program;
  /** Resolves a module specifier the way the program does; undefined when it does not resolve. */
  resolveModule(specifier: ts.StringLiteralLike, from: ts.SourceFile): string | undefined;
  /** Resolves a specifier as if written in `fromFile`, which need not exist or be parsed. */
  resolveFrom(specifier: string, fromFile: string): string | undefined;
  /** Whether two paths name the same file for the compiler. */
  sameFile(a: string, b: string): boolean;
}

/**
 * A compiler host that serves in-memory texts in place of the disk: the
 * files need not exist, and a stale file on disk is never read instead of
 * them. File existence, reads and module resolution all go through it.
 */
export function createOverlay(ts: TypeScript, options: ts.CompilerOptions, initial: ReadonlyMap<string, string>): Overlay {
  const base = ts.createCompilerHost(options, true);
  const key = (fileName: string) => base.getCanonicalFileName(path.resolve(fileName));
  const files = new Map<string, string>();
  // The directories of in-memory files, and their parents: module resolution asks before it looks for a file.
  const directories = new Set<string>();
  // The library and the project's files are the same for every program of one run: parse them once.
  const parsed = new Map<string, ts.SourceFile>();
  const overlayText = (fileName: string) => files.get(key(fileName));
  const add = (added: ReadonlyMap<string, string>) => {
    for (const [fileName, text] of added) {
      files.set(key(fileName), text);
      parsed.delete(key(fileName));
      for (let directory = path.dirname(path.resolve(fileName)); !directories.has(key(directory)); directory = path.dirname(directory)) {
        directories.add(key(directory));
        if (path.dirname(directory) === directory) break;
      }
    }
  };
  add(initial);

  const host: ts.CompilerHost = {
    ...base,
    fileExists: (fileName) => overlayText(fileName) !== undefined || base.fileExists(fileName),
    directoryExists: (directory) => directories.has(key(directory)) || (base.directoryExists?.(directory) ?? false),
    readFile: (fileName) => overlayText(fileName) ?? base.readFile(fileName),
    realpath: (fileName) => (overlayText(fileName) !== undefined ? fileName : (base.realpath?.(fileName) ?? fileName)),
    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const cached = parsed.get(key(fileName));
      if (cached) return cached;
      const text = overlayText(fileName);
      const sourceFile =
        text === undefined ? base.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) : ts.createSourceFile(fileName, text, languageVersion, true);
      // A file that could not be read is not remembered: the next program asks again and gets the reason.
      if (sourceFile) parsed.set(key(fileName), sourceFile);
      return sourceFile;
    },
  };
  const resolve = (specifier: string, fromFile: string, mode: ts.ResolutionMode) =>
    ts.resolveModuleName(specifier, fromFile, options, host, undefined, undefined, mode).resolvedModule?.resolvedFileName;
  return {
    add,
    createProgram: (rootNames) => ts.createProgram({ rootNames, options, host }),
    resolveModule: (specifier, from) => resolve(specifier.text, from.fileName, ts.getModeForUsageLocation(from, specifier, options)),
    resolveFrom: (specifier, fromFile) => resolve(specifier, fromFile, ts.getImpliedNodeFormatForFile(fromFile, undefined, host, options)),
    sameFile: (a, b) => key(a) === key(b),
  };
}

/** A program whose roots are the given in-memory texts. */
export function createOverlayProgram(ts: TypeScript, options: ts.CompilerOptions, files: ReadonlyMap<string, string>): Overlay & { program: ts.Program } {
  const overlay = createOverlay(ts, options, files);
  return { ...overlay, program: overlay.createProgram([...files.keys()]) };
}

export function requireSourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`${fileName} is missing from the TypeScript program.`);
  return sourceFile;
}
