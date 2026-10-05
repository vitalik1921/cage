import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import { indexDesigns, type ImportTarget } from "./design-index.ts";
import type { DesignIndex } from "./design-model.ts";
import { compareDiagnostics, isError, type Diagnostic } from "./diagnostic.ts";
import { DESIGN_SUFFIX, type DesignSource } from "./discovery.ts";
import { blockAt, buildGeneratedModule, CAGE_DIRECTORY, extractBlock, toSourceOffset, VIRTUAL_FILE_NAME, type ExtractedText, type GeneratedModule, type Replacement } from "./extraction.ts";
import { lineStarts, positionAt, stripBom, toProjectPath, type Position } from "./location.ts";
import { parseDesignMdx, type DesignBlock } from "./mdx.ts";
import {
  createOverlayProgram,
  loadTypeScript,
  readCompilerOptions,
  requireSourceFile,
  syntaxOnlyOptions,
  type Overlay,
  type TypeScript,
  type TypeScriptInfo,
} from "./typescript.ts";

/** One `*.cage.mdx` document of a module. */
export interface DesignDocument {
  /** Relative to the project root. */
  file: string;
  /** Text without a byte order mark. */
  source: string;
  sourceLines: readonly number[];
  blocks: DesignBlock[];
}

/** A module's design: its documents, and the virtual module assembled from all their blocks. */
export interface DesignModule extends DesignSource {
  documents: DesignDocument[];
  /** The virtual design file, relative to the project root. */
  virtualPath: string;
  generated: GeneratedModule;
}

export interface DesignPhaseOptions {
  root: string;
  /** Relative to `root`. */
  tsconfig: string;
  designs: readonly DesignSource[];
  /** The `designs` patterns the sources were found with; named when there are none. */
  designPatterns?: readonly string[];
  /** Errors found before the phase, in the configuration. With any, nothing is checked and only they are reported. */
  problems?: readonly Diagnostic[];
}

export interface DesignPhaseResult {
  modules: DesignModule[];
  /**
   * Contracts, data types, invariants and declared dependencies. Null when an
   * earlier layer failed and the designs were not indexed, which is not the
   * same as a scope without contracts.
   */
  index: DesignIndex | null;
  typescript: TypeScriptInfo;
  /** The compiler, the project's options and files, and the overlay that holds the generated modules; absent when the tsconfig could not be used. */
  compiler?: { ts: TypeScript; options: ts.CompilerOptions; fileNames: string[]; overlay: Overlay };
  diagnostics: Diagnostic[];
}

/**
 * Design phase: extracts every design in memory, indexes its contracts and
 * type-checks the extracted modules through a compiler overlay at their
 * generated paths. Nothing is written; generated files on disk are neither
 * required nor read.
 *
 * The checks run in layers: documents, each block on its own, the compiler
 * setup, declarations and tags, types. A layer runs only if the earlier ones
 * left nothing in the whole scope that would make its results consequences
 * of their errors.
 */
export function checkDesignPhase(options: DesignPhaseOptions): DesignPhaseResult {
  const root = path.resolve(options.root);
  const { ts, info } = loadTypeScript(root);
  const modules: DesignModule[] = [];
  const diagnostics: Diagnostic[] = [];
  const result: DesignPhaseResult = { modules, index: null, typescript: info, diagnostics };
  const failed = (...codes: string[]) => diagnostics.some((diagnostic) => isError(diagnostic) && (codes.length === 0 || codes.includes(diagnostic.code)));
  const done = () => {
    diagnostics.sort(compareDiagnostics);
    return result;
  };

  diagnostics.push(...(options.problems ?? []));
  if (failed()) return done();

  readDocuments(ts, root, options.designs, options.designPatterns ?? [], modules, diagnostics);
  if (failed()) return done();

  diagnostics.push(...checkBlocks(ts, root, modules));
  if (failed()) return done();

  // With an unreadable tsconfig, invalid options or missing global types every other result is unreliable.
  const tsconfig = path.resolve(root, options.tsconfig);
  const environment = (convert: Converter, found: readonly ts.Diagnostic[]) => diagnostics.push(...environmentDiagnostics(convert, toProjectPath(root, tsconfig), found));
  const setup = readCompilerOptions(ts, tsconfig);
  environment(createConverter(ts, root, undefined, new Map()), setup.errors);
  if (failed()) return done();

  const overlay = createOverlayProgram(ts, setup.options, new Map(modules.map((module) => [module.virtualFile, module.generated.text])));
  const origins = new Map(
    modules.map((module): [ts.SourceFile, Origin] => [requireSourceFile(overlay.program, module.virtualFile), { module, extracted: module.generated }]),
  );
  const convert = createConverter(ts, root, overlay.program, origins);
  environment(convert, [...overlay.program.getOptionsDiagnostics(), ...overlay.program.getGlobalDiagnostics()]);
  if (failed()) return done();
  result.compiler = { ts, options: setup.options, fileNames: setup.fileNames, overlay };

  const indexed = indexDesigns(
    ts,
    [...origins].map(([sourceFile, origin]) => ({
      moduleId: origin.module.moduleId,
      sourceFile,
      locate: (offset) => {
        // What the index reports are tokens and comments of the blocks, so every offset has an authored position.
        const position = authoredPosition(origin, offset);
        if (!position) throw new Error(`Offset ${offset} of ${origin.module.virtualPath} was not copied from a design document.`);
        return position;
      },
      blockOf: (offset) => blockAt(origin.module.generated, offset),
      writtenSpecifier: (specifier) => origin.module.generated.writtenSpecifiers.get(specifier.getStart(sourceFile)) ?? specifier.text,
    })),
    (specifier, from): ImportTarget => {
      const resolved = overlay.resolveModule(specifier, from);
      const target = resolved === undefined ? undefined : modules.find((module) => overlay.sameFile(module.virtualFile, resolved));
      if (target) return { moduleId: target.moduleId, documents: target.documents.map((document) => path.posix.basename(document.file)) };
      // A design document is named as such in the document; it resolved to nothing when its module is not in the scope.
      const written = origins.get(from)?.module.generated.writtenSpecifiers.get(specifier.getStart(from)) ?? specifier.text;
      return written.endsWith(DESIGN_SUFFIX) ? "out-of-scope" : "other";
    },
  );
  result.index = indexed.index;
  diagnostics.push(...indexed.diagnostics);
  // An import that is not allowed would show up again as an unresolved module or as types read from the disk.
  if (failed("E_DESIGN_IMPORT", "E_DESIGN_OUT_OF_SCOPE")) return done();

  for (const sourceFile of origins.keys()) {
    const found = [...overlay.program.getSyntacticDiagnostics(sourceFile), ...overlay.program.getSemanticDiagnostics(sourceFile)];
    diagnostics.push(...found.map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
  }
  return done();
}

/**
 * Reads the documents of every module. The documents of one module are one
 * design: their blocks make one generated module, in the order of their
 * names, and prose in any of them is the business context of all.
 */
function readDocuments(ts: TypeScript, root: string, designs: readonly DesignSource[], patterns: readonly string[], modules: DesignModule[], diagnostics: Diagnostic[]): void {
  if (designs.length === 0) {
    diagnostics.push({
      code: "E_NO_DESIGNS",
      severity: "error",
      message: `no *.cage.mdx matches ${patterns.length > 0 ? patterns.join(", ") : "the designs patterns"}`,
    });
  }
  for (const design of designs) {
    const documents: DesignDocument[] = [];
    let readable = true;
    let hasBusinessContext = false;
    let hasProblems = false;
    for (const sourceFile of design.sourceFiles) {
      const file = toProjectPath(root, sourceFile);
      let source: string;
      try {
        source = stripBom(fs.readFileSync(sourceFile, "utf8"));
      } catch (cause) {
        diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `cannot read the design document: ${(cause as Error).message}`, file });
        readable = false;
        continue;
      }
      const parsed = parseDesignMdx(source, file);
      diagnostics.push(...parsed.diagnostics);
      hasProblems ||= parsed.diagnostics.length > 0;
      hasBusinessContext ||= parsed.hasBusinessContext;
      documents.push({ file, source, sourceLines: lineStarts(source), blocks: parsed.blocks });
    }
    if (!readable) continue;
    const names = documents.map((document) => document.file);
    // Misplaced or empty blocks are already reported; do not cascade into "missing".
    if (documents.every((document) => document.blocks.length === 0) && !hasProblems) {
      diagnostics.push({
        code: "E_DESIGN_BLOCK_MISSING",
        severity: "error",
        message: `${design.moduleId}: no ts design block in ${names.join(", ")}`,
        file: names[0],
      });
    } else if (!hasBusinessContext && documents.some((document) => document.blocks.length > 0)) {
      diagnostics.push({
        code: "W_BUSINESS_CONTEXT_MISSING",
        severity: "warning",
        message: `${design.moduleId}: no prose outside the code blocks`,
        file: names[0],
      });
    }
    modules.push({
      ...design,
      documents,
      virtualPath: toProjectPath(root, design.virtualFile),
      generated: buildGeneratedModule(
        documents.map((document) => ({ name: path.posix.basename(document.file), blocks: document.blocks, replacements: specifierReplacements(ts, document.blocks) })),
      ),
    });
  }
}

/**
 * How the virtual module spells the module specifiers of a document. A design
 * imports another design by one of its documents: `../quota/quota.cage.mdx`,
 * or through a path alias. The compiler is given the other module's virtual
 * file instead, `../quota/.cage/design.ts`. And a relative specifier is
 * written for the document's directory while the virtual file lives in
 * `.cage/` below it, so it gets a `../` in front. What is not relative (bare
 * names, path aliases) is the same from anywhere.
 */
function specifierReplacements(ts: TypeScript, blocks: readonly DesignBlock[]): Map<number, Replacement[]> {
  const replacements = new Map<number, Replacement[]>();
  blocks.forEach((block, order) => {
    const text = block.lines.map((line) => line.text).join("\n");
    const sourceFile = ts.createSourceFile("block.ts", text, ts.ScriptTarget.Latest, false);
    for (const statement of sourceFile.statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const relative = /^\.\.?\//.test(specifier.text);
      const isDocument = specifier.text.endsWith(DESIGN_SUFFIX);
      if (!relative && !isDocument) continue;
      const toModule = isDocument ? `${path.posix.dirname(specifier.text)}/${CAGE_DIRECTORY}/${VIRTUAL_FILE_NAME}` : specifier.text;
      const rewritten = relative ? `../${toModule}` : toModule;
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile) + 1);
      replacements.set(order, [...(replacements.get(order) ?? []), { line, column: character, length: specifier.text.length, text: rewritten, original: specifier.text }]);
    }
  });
  return replacements;
}

/** Problems of the compiler setup, as diagnostics of the project's tsconfig unless the compiler names another file. */
export function environmentDiagnostics(convert: Converter, tsconfig: string, found: readonly ts.Diagnostic[]): Diagnostic[] {
  return found.map((diagnostic) => {
    const converted = convert("E_ENVIRONMENT", diagnostic);
    return { ...converted, file: converted.file ?? tsconfig, message: `TypeScript configuration: ${converted.message}` };
  });
}

/** Text given to the compiler and the design it was extracted from. */
export interface Origin {
  module: DesignModule;
  extracted: ExtractedText;
}

/** The document and position of an offset of extracted text; undefined for text that was not copied from a block. */
function authoredPosition({ module, extracted }: Origin, offset: number): (Position & { file: string }) | undefined {
  const source = toSourceOffset(extracted, offset);
  if (source === undefined) return undefined;
  const document = module.documents[source.document];
  return { file: document.file, ...positionAt(document.sourceLines, source.offset) };
}

type Location = Pick<Diagnostic, "file" | "line" | "column" | "endLine" | "endColumn">;
export type Converter = (code: string, diagnostic: ts.Diagnostic) => Diagnostic;

/**
 * Converts compiler diagnostics. Positions in extracted text are mapped to
 * the authored MDX; positions that were not copied from a block (header,
 * separators) keep only the document and are marked in the message.
 */
export function createConverter(ts: TypeScript, root: string, program: ts.Program | undefined, origins: ReadonlyMap<ts.SourceFile, Origin>): Converter {
  const locate = (file: ts.SourceFile | undefined, start: number | undefined, length = 0): Location & { unmapped?: boolean } => {
    if (!file) return {};
    const origin = origins.get(file);
    if (!origin) {
      // The compiler's library lives wherever it is installed; keep reports machine-independent.
      const name = program?.isSourceFileDefaultLibrary(file) ? `typescript/lib/${path.basename(file.fileName)}` : toProjectPath(root, file.fileName);
      if (start === undefined) return { file: name };
      const from = ts.getLineAndCharacterOfPosition(file, start);
      const to = ts.getLineAndCharacterOfPosition(file, start + length);
      return { file: name, line: from.line + 1, column: from.character + 1, endLine: to.line + 1, endColumn: to.character + 1 };
    }
    const from = start === undefined ? undefined : authoredPosition(origin, start);
    // Header and separators belong to no document; the first one stands for the module.
    if (start === undefined || !from) return { file: origin.module.documents[0].file, unmapped: start !== undefined };
    const to = authoredPosition(origin, start + length);
    return to ? { ...from, endLine: to.line, endColumn: to.column } : from;
  };

  // The compiler names a type that is ambiguous by the absolute path of its module; the report keeps paths from the project root.
  // Only where a path starts: the same characters in the middle of another path are not the project root.
  const rootPath = new RegExp(`(?<![\\w./-])${`${root.split(path.sep).join("/")}/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g");
  const text = (message: string | ts.DiagnosticMessageChain) => ts.flattenDiagnosticMessageText(message, "\n").replace(rootPath, "");

  return (code, diagnostic) => {
    const { unmapped, ...location } = locate(diagnostic.file, diagnostic.start, diagnostic.length);
    const message = text(diagnostic.messageText);
    const related = diagnostic.relatedInformation?.map((info) => {
      const { unmapped: _, ...at } = locate(info.file, info.start, info.length);
      return { message: text(info.messageText), ...at };
    });
    return {
      code,
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      message: unmapped ? `${message} (outside the authored ts design blocks)` : message,
      ...location,
      tsCode: diagnostic.code,
      ...(related?.length ? { related } : {}),
    };
  };
}

/**
 * Every block is checked on its own, before anything is compiled together.
 * It must be complete TypeScript: a declaration or comment left open would
 * otherwise silently absorb the next block. And it must not start with a
 * `/// <reference>` directive, which would add files, packages or libraries
 * to the program, or take the default library out of it, past the import rules.
 */
function checkBlocks(ts: TypeScript, root: string, modules: readonly DesignModule[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const files = new Map<string, Origin>();
  for (const module of modules) {
    let order = 0;
    for (const [index, document] of module.documents.entries()) {
      for (const block of document.blocks) {
        const origin: Origin = { module, extracted: extractBlock(block, index) };
        order += 1;
        files.set(path.join(path.dirname(module.virtualFile), `block-${order}.ts`), origin);
        const { text } = origin.extracted;
        for (const comment of ts.getLeadingCommentRanges(text, 0) ?? []) {
          if (!/^\/\/\/\s*<reference\b/.test(text.slice(comment.pos, comment.end))) continue;
          diagnostics.push({
            code: "E_DESIGN_IMPORT",
            severity: "error",
            message: "`/// <reference>` in a ts design block",
            ...authoredPosition(origin, comment.pos),
          });
        }
      }
    }
  }
  const { program } = createOverlayProgram(ts, syntaxOnlyOptions, new Map([...files].map(([fileName, origin]) => [fileName, origin.extracted.text])));
  const origins = new Map([...files].map(([fileName, origin]) => [requireSourceFile(program, fileName), origin]));
  const convert = createConverter(ts, root, program, origins);
  for (const sourceFile of origins.keys()) diagnostics.push(...program.getSyntacticDiagnostics(sourceFile).map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
  return diagnostics;
}
