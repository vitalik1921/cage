import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { compareDiagnostics, type Diagnostic } from "./diagnostic.ts";
import type { DesignSource } from "./discovery.ts";
import { buildGeneratedModule, extractBlock, toSourceOffset, type ExtractedText } from "./extraction.ts";
import { lineStarts, positionAt, stripBom, toProjectPath } from "./location.ts";
import { parseDesignMdx, type DesignBlock } from "./mdx.ts";
import {
  createOverlayProgram,
  findNoCheckPragmas,
  readCompilerOptions,
  requireSourceFile,
  syntaxOnlyOptions,
} from "./typescript.ts";

export interface DesignModule extends DesignSource {
  /** Document text without a byte order mark. */
  source: string;
  blocks: DesignBlock[];
  generated: ExtractedText;
}

export interface DesignPhaseOptions {
  root: string;
  /** Relative to `root`. */
  tsconfig: string;
  designs: readonly DesignSource[];
}

export interface DesignPhaseResult {
  modules: DesignModule[];
  diagnostics: Diagnostic[];
}

/**
 * Design phase: extracts every design in memory and type-checks the extracted
 * modules through a compiler overlay at their generated paths. Nothing is
 * written; generated files on disk are neither required nor read.
 *
 * The checks run in layers: documents, then each block's syntax, then types.
 * A layer runs only if the previous ones found no errors in the whole scope,
 * since its results would otherwise be consequences of those errors.
 */
export function checkDesignPhase(options: DesignPhaseOptions): DesignPhaseResult {
  const root = path.resolve(options.root);
  const modules: DesignModule[] = [];
  const diagnostics: Diagnostic[] = [];
  const hasErrors = () => diagnostics.some((diagnostic) => diagnostic.severity === "error");

  if (options.designs.length === 0) {
    diagnostics.push({
      code: "E_NO_DESIGNS",
      severity: "error",
      message: "No .design/design.mdx documents were found. Check the project root and the `designs` patterns.",
    });
  }
  for (const design of options.designs) {
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
    modules.push({ ...design, source, blocks: parsed.blocks, generated: buildGeneratedModule(parsed.blocks) });
  }

  if (!hasErrors()) diagnostics.push(...checkBlocks(root, modules));
  if (!hasErrors()) diagnostics.push(...checkTypes(root, path.resolve(root, options.tsconfig), modules));
  return { modules, diagnostics: diagnostics.sort(compareDiagnostics) };
}

/** Text given to the compiler and the design it was extracted from. */
interface Origin {
  module: DesignModule;
  extracted: ExtractedText;
}

type Location = Pick<Diagnostic, "file" | "line" | "column" | "endLine" | "endColumn">;

/**
 * Converts compiler diagnostics. Positions in extracted text are mapped to
 * the authored MDX; positions that were not copied from a block (header,
 * separators) keep only the document and are marked in the message.
 */
function createConverter(root: string, program: ts.Program | undefined, origins: ReadonlyMap<ts.SourceFile, Origin>) {
  const sourceLines = new Map<DesignModule, number[]>();
  const linesOf = (module: DesignModule) => {
    let starts = sourceLines.get(module);
    if (!starts) sourceLines.set(module, (starts = lineStarts(module.source)));
    return starts;
  };

  const locate = (file: ts.SourceFile | undefined, start: number | undefined, length = 0): Location & { unmapped?: boolean } => {
    if (!file) return {};
    const origin = origins.get(file);
    if (!origin) {
      // The bundled library lives wherever the harness is installed; keep reports machine-independent.
      const name = program?.isSourceFileDefaultLibrary(file)
        ? `typescript/lib/${path.basename(file.fileName)}`
        : toProjectPath(root, file.fileName);
      if (start === undefined) return { file: name };
      const from = ts.getLineAndCharacterOfPosition(file, start);
      const to = ts.getLineAndCharacterOfPosition(file, start + length);
      return { file: name, line: from.line + 1, column: from.character + 1, endLine: to.line + 1, endColumn: to.character + 1 };
    }
    const mdx = toProjectPath(root, origin.module.sourceFile);
    const sourceStart = start === undefined ? undefined : toSourceOffset(origin.extracted, start);
    if (start === undefined || sourceStart === undefined) return { file: mdx, unmapped: start !== undefined };
    const from = positionAt(linesOf(origin.module), sourceStart);
    const sourceEnd = toSourceOffset(origin.extracted, start + length);
    if (sourceEnd === undefined) return { file: mdx, ...from };
    const to = positionAt(linesOf(origin.module), sourceEnd);
    return { file: mdx, ...from, endLine: to.line, endColumn: to.column };
  };

  return (code: string, diagnostic: ts.Diagnostic): Diagnostic => {
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
 * Every block must be complete TypeScript on its own: a declaration or comment
 * left open in one block would otherwise silently absorb the next one.
 */
function checkBlocks(root: string, modules: readonly DesignModule[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const files = new Map<string, Origin>();
  for (const module of modules) {
    const starts = lineStarts(module.source);
    for (const offset of findNoCheckPragmas(module.generated.text)) {
      diagnostics.push({
        code: "E_UNSUPPORTED_DECLARATION",
        severity: "error",
        message: "`@ts-nocheck` would switch off type checking of the whole design; it is not allowed in ts design blocks.",
        file: toProjectPath(root, module.sourceFile),
        ...positionAt(starts, toSourceOffset(module.generated, offset)!),
      });
    }
    for (const block of module.blocks) {
      const fileName = path.join(path.dirname(module.generatedFile), `design.block-${block.order + 1}.ts`);
      files.set(fileName, { module, extracted: extractBlock(block) });
    }
  }

  const texts = new Map([...files].map(([fileName, origin]) => [fileName, origin.extracted.text]));
  const program = createOverlayProgram(syntaxOnlyOptions, texts);
  const origins = new Map([...files].map(([fileName, origin]) => [requireSourceFile(program, fileName), origin]));
  const convert = createConverter(root, program, origins);
  for (const sourceFile of origins.keys()) {
    diagnostics.push(...program.getSyntacticDiagnostics(sourceFile).map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
  }
  return diagnostics;
}

function checkTypes(root: string, tsconfigFile: string, modules: readonly DesignModule[]): Diagnostic[] {
  const setup = readCompilerOptions(tsconfigFile);
  const environment = (convert: ReturnType<typeof createConverter>, errors: readonly ts.Diagnostic[]) =>
    errors.map((diagnostic): Diagnostic => {
      const converted = convert("E_ENVIRONMENT", diagnostic);
      return { ...converted, file: converted.file ?? toProjectPath(root, tsconfigFile), message: `TypeScript configuration: ${converted.message}` };
    });
  if (setup.errors.length > 0) return environment(createConverter(root, undefined, new Map()), setup.errors);

  const program = createOverlayProgram(setup.options, new Map(modules.map((module) => [module.generatedFile, module.generated.text])));
  const origins = new Map(
    modules.map((module): [ts.SourceFile, Origin] => [requireSourceFile(program, module.generatedFile), { module, extracted: module.generated }]),
  );
  const convert = createConverter(root, program, origins);

  // With invalid options or missing global types every other result is unreliable.
  const invalid = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (invalid.length > 0) return environment(convert, invalid);

  return [...origins.keys()].flatMap((sourceFile) =>
    [...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map((diagnostic) =>
      convert("E_TYPESCRIPT", diagnostic),
    ),
  );
}
