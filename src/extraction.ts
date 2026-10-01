import { lastStartingAtOrBefore } from "./location.ts";
import type { BlockLine, DesignBlock } from "./mdx.ts";

/**
 * Where a module's design is given to the compiler: a virtual TypeScript file
 * `<module>/.cage/design.ts`, never written. A dot-directory, so that no file
 * of the project can be in its place.
 */
export const CAGE_DIRECTORY = ".cage";
export const VIRTUAL_FILE_NAME = "design.ts";

/** One copied line: `length` characters at `generatedStart` come from `sourceStart` in document `document`. */
export interface Segment {
  generatedStart: number;
  sourceStart: number;
  length: number;
  /** Index of the design document the line was copied from. */
  document: number;
}

/** TypeScript text assembled from design block lines, with its mapping back to the documents. */
export interface ExtractedText {
  text: string;
  /** Sorted by `generatedStart`; text that was not copied from a block has no segment. */
  segments: Segment[];
}

export interface GeneratedModule extends ExtractedText {
  /** Offset in `text` where each design block starts, in document order. */
  blockStarts: number[];
  /** Offset in `text` of each module specifier that was rewritten, to what the document says. */
  writtenSpecifiers: Map<number, string>;
}

/**
 * Text of a block line that the virtual module spells differently: a module
 * specifier, written in the document for the document's directory, rewritten
 * for the virtual file. `line` and `column` are within the block; `length`
 * characters of the line are replaced by `text`.
 */
export interface Replacement {
  line: number;
  column: number;
  length: number;
  text: string;
  /** The text as the document writes it, for messages. */
  original: string;
}

/** The blocks of one document of a module, with the name the header lists and what to rewrite in each block. */
export interface DocumentBlocks {
  name: string;
  blocks: readonly DesignBlock[];
  /** By index in `blocks`. */
  replacements?: ReadonlyMap<number, readonly Replacement[]>;
}

/** The first line of the virtual module: which documents it was assembled from. */
export const moduleHeader = (names: readonly string[]) => `// cage: the design of this module, assembled from ${names.join(", ")}\n`;

/** The virtual module: a header line, an empty line, then the blocks of every document separated by an empty line. */
export function buildGeneratedModule(documents: readonly DocumentBlocks[]): GeneratedModule {
  const module: GeneratedModule = { text: `${moduleHeader(documents.map((document) => document.name))}\n`, segments: [], blockStarts: [], writtenSpecifiers: new Map() };
  documents.forEach((document, index) => {
    document.blocks.forEach((block, order) => {
      if (module.blockStarts.length > 0) module.text += "\n\n";
      module.blockStarts.push(module.text.length);
      appendLines(module, block.lines, index, document.replacements?.get(order) ?? [], module.writtenSpecifiers);
    });
  });
  module.text += "\n";
  return module;
}

/** Index of the block that holds an offset of the generated text; the header counts as the first block. */
export function blockAt(module: GeneratedModule, offset: number): number {
  return lastStartingAtOrBefore(module.blockStarts, (start) => start, offset);
}

/** One block on its own, used to check that it is syntactically complete. */
export function extractBlock(block: DesignBlock, document: number): ExtractedText {
  const extracted: ExtractedText = { text: "", segments: [] };
  appendLines(extracted, block.lines, document);
  return extracted;
}

function appendLines(target: ExtractedText, lines: readonly BlockLine[], document: number, replacements: readonly Replacement[] = [], written?: Map<number, string>): void {
  lines.forEach((line, index) => {
    if (index > 0) target.text += "\n";
    let column = 0;
    // A replacement splits the line: what surrounds it maps to the document, the replacement itself maps nowhere.
    for (const replacement of replacements.filter((candidate) => candidate.line === index).sort((a, b) => a.column - b.column)) {
      const before = line.text.slice(column, replacement.column);
      if (before.length > 0) target.segments.push({ generatedStart: target.text.length, sourceStart: line.sourceStart + column, length: before.length, document });
      target.text += before;
      // The specifier's opening quote is the character before the replaced text.
      written?.set(target.text.length - 1, replacement.original);
      target.text += replacement.text;
      column = replacement.column + replacement.length;
    }
    const rest = line.text.slice(column);
    target.segments.push({ generatedStart: target.text.length, sourceStart: line.sourceStart + column, length: rest.length, document });
    target.text += rest;
  });
}

/**
 * Maps an offset in extracted text to a document and an offset in it. The
 * end of a copied line, and the end of the text, map to the end of the
 * authored line. Header and separator offsets have no authored position and
 * return undefined.
 */
export function toSourceOffset(extracted: ExtractedText, offset: number): { document: number; offset: number } | undefined {
  const { text, segments } = extracted;
  const last = segments.at(-1);
  if (!last) return undefined;
  if (offset === text.length) return { document: last.document, offset: last.sourceStart + last.length };
  const segment = segments[lastStartingAtOrBefore(segments, (item) => item.generatedStart, offset)];
  if (offset < segment.generatedStart || offset > segment.generatedStart + segment.length) return undefined;
  return { document: segment.document, offset: segment.sourceStart + (offset - segment.generatedStart) };
}
