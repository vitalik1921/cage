import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import { indexDesigns, type ImportTarget } from "./design-index.ts";
import type { DesignIndex } from "./design-model.ts";
import { compareDiagnostics, isError, type Diagnostic } from "./diagnostic.ts";
import type { DesignSource } from "./discovery.ts";
import { blockAt, buildGeneratedModule, extractBlock, toSourceOffset, type ExtractedText, type GeneratedModule } from "./extraction.ts";
import { lineStarts, positionAt, stripBom, toProjectPath, type Position } from "./location.ts";
import { parseDesignMdx, type DesignBlock } from "./mdx.ts";
import {
  createOverlayProgram,
  loadTypeScript,
  readCompilerOptions,
  requireSourceFile,
  syntaxOnlyOptions,
  type TypeScript,
  type TypeScriptInfo,
} from "./typescript.ts";

export interface DesignModule extends DesignSource {
  /** The design document, relative to the project root. */
  file: string;
  /** The generated file, relative to the project root. */
  generatedPath: string;
  /** Document text without a byte order mark. */
  source: string;
  sourceLines: readonly number[];
  blocks: DesignBlock[];
  generated: GeneratedModule;
}

export interface DesignPhaseOptions {
  root: string;
  /** Relative to `root`. */
  tsconfig: string;
  designs: readonly DesignSource[];
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

  readDocuments(root, options.designs, modules, diagnostics);
  if (failed()) return done();

  diagnostics.push(...checkBlocks(ts, root, modules));
  if (failed()) return done();

  // With an unreadable tsconfig, invalid options or missing global types every other result is unreliable.
  const tsconfig = path.resolve(root, options.tsconfig);
  const environment = (convert: Converter, found: readonly ts.Diagnostic[]) => {
    for (const diagnostic of found) {
      const converted = convert("E_ENVIRONMENT", diagnostic);
      diagnostics.push({ ...converted, file: converted.file ?? toProjectPath(root, tsconfig), message: `TypeScript configuration: ${converted.message}` });
    }
  };
  const setup = readCompilerOptions(ts, tsconfig);
  environment(createConverter(ts, root, undefined, new Map()), setup.errors);
  if (failed()) return done();

  const overlay = createOverlayProgram(ts, setup.options, new Map(modules.map((module) => [module.generatedFile, module.generated.text])));
  const origins = new Map(
    modules.map((module): [ts.SourceFile, Origin] => [requireSourceFile(overlay.program, module.generatedFile), { module, extracted: module.generated }]),
  );
  const convert = createConverter(ts, root, overlay.program, origins);
  environment(convert, [...overlay.program.getOptionsDiagnostics(), ...overlay.program.getGlobalDiagnostics()]);
  if (failed()) return done();

  const indexed = indexDesigns(
    ts,
    [...origins].map(([sourceFile, origin]) => ({
      moduleId: origin.module.moduleId,
      sourceFile,
      locate: (offset) => {
        // What the index reports are tokens and comments of the blocks, so every offset has an authored position.
        const position = authoredPosition(origin, offset);
        if (!position) throw new Error(`Offset ${offset} of ${origin.module.generatedPath} was not copied from the design document.`);
        return { file: origin.module.file, ...position };
      },
      blockOf: (offset) => blockAt(origin.module.generated, offset),
    })),
    (specifier, from): ImportTarget => {
      const resolved = overlay.resolveModule(specifier, from);
      const target = resolved === undefined ? undefined : modules.find((module) => overlay.sameFile(module.generatedFile, resolved));
      if (target) return { moduleId: target.moduleId };
      // An unresolved specifier may have no extension; a resolved one is a file name.
      const fileName = path.posix.basename((resolved ?? specifier.text).replaceAll("\\", "/"));
      return /^design\.generated(\.[cm]?[jt]s)?$/.test(fileName) ? "out-of-scope" : "other";
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

function readDocuments(root: string, designs: readonly DesignSource[], modules: DesignModule[], diagnostics: Diagnostic[]): void {
  if (designs.length === 0) {
    diagnostics.push({
      code: "E_NO_DESIGNS",
      severity: "error",
      message: "No .design/design.mdx documents were found. Check the project root and the `designs` patterns.",
    });
  }
  for (const design of designs) {
    const file = toProjectPath(root, design.sourceFile);
    let source: string;
    try {
      source = stripBom(fs.readFileSync(design.sourceFile, "utf8"));
    } catch (cause) {
      diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot read the design document: ${(cause as Error).message}`, file });
      continue;
    }
    const parsed = parseDesignMdx(source, file);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.blocks.length > 0 && !parsed.hasBusinessContext) {
      diagnostics.push({
        code: "W_BUSINESS_CONTEXT_MISSING",
        severity: "warning",
        message: "The design document has no prose outside its code blocks: a reviewer gets the contracts without their business context.",
        file,
      });
    }
    modules.push({
      ...design,
      file,
      generatedPath: toProjectPath(root, design.generatedFile),
      source,
      sourceLines: lineStarts(source),
      blocks: parsed.blocks,
      generated: buildGeneratedModule(parsed.blocks),
    });
  }
}

/** Text given to the compiler and the design it was extracted from. */
interface Origin {
  module: DesignModule;
  extracted: ExtractedText;
}

/** The position in the MDX of an offset of extracted text; undefined for text that was not copied from a block. */
function authoredPosition({ module, extracted }: Origin, offset: number): Position | undefined {
  const sourceOffset = toSourceOffset(extracted, offset);
  return sourceOffset === undefined ? undefined : positionAt(module.sourceLines, sourceOffset);
}

type Location = Pick<Diagnostic, "file" | "line" | "column" | "endLine" | "endColumn">;
type Converter = (code: string, diagnostic: ts.Diagnostic) => Diagnostic;

/**
 * Converts compiler diagnostics. Positions in extracted text are mapped to
 * the authored MDX; positions that were not copied from a block (header,
 * separators) keep only the document and are marked in the message.
 */
function createConverter(ts: TypeScript, root: string, program: ts.Program | undefined, origins: ReadonlyMap<ts.SourceFile, Origin>): Converter {
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
    if (start === undefined || !from) return { file: origin.module.file, unmapped: start !== undefined };
    const to = authoredPosition(origin, start + length);
    return to ? { file: origin.module.file, ...from, endLine: to.line, endColumn: to.column } : { file: origin.module.file, ...from };
  };

  return (code, diagnostic) => {
    const { unmapped, ...location } = locate(diagnostic.file, diagnostic.start, diagnostic.length);
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    const related = diagnostic.relatedInformation?.map((info) => {
      const { unmapped: _, ...at } = locate(info.file, info.start, info.length);
      return { message: ts.flattenDiagnosticMessageText(info.messageText, "\n"), ...at };
    });
    return {
      code,
      severity: diagnostic.category === ts.DiagnosticCategory.Error ? "error" : "warning",
      message: unmapped ? `${message} (reported outside the authored ts design blocks)` : message,
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
    for (const block of module.blocks) {
      const origin: Origin = { module, extracted: extractBlock(block) };
      files.set(path.join(path.dirname(module.generatedFile), `design.block-${block.order + 1}.ts`), origin);
      const { text } = origin.extracted;
      for (const comment of ts.getLeadingCommentRanges(text, 0) ?? []) {
        if (!/^\/\/\/\s*<reference\b/.test(text.slice(comment.pos, comment.end))) continue;
        diagnostics.push({
          code: "E_DESIGN_IMPORT",
          severity: "error",
          message: "`/// <reference>` is not allowed in a ts design block; a design may import only types of other designs, with `import type`.",
          file: module.file,
          ...authoredPosition(origin, comment.pos),
        });
      }
    }
  }
  const { program } = createOverlayProgram(ts, syntaxOnlyOptions, new Map([...files].map(([fileName, origin]) => [fileName, origin.extracted.text])));
  const origins = new Map([...files].map(([fileName, origin]) => [requireSourceFile(program, fileName), origin]));
  const convert = createConverter(ts, root, program, origins);
  for (const sourceFile of origins.keys()) diagnostics.push(...program.getSyntacticDiagnostics(sourceFile).map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
  return diagnostics;
}
