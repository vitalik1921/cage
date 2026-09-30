import type { Code, Nodes, Root } from "mdast";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Diagnostic } from "./diagnostic.ts";
import { lineStarts, positionAt, splitLines, type Position } from "./location.ts";

export interface BlockLine {
  /** Line content without its line ending. */
  text: string;
  /** Offset of the line start in the MDX source. */
  sourceStart: number;
}

export interface DesignBlock {
  order: number;
  /** Range of the whole fenced block, fences included, in the MDX source. */
  sourceStart: number;
  sourceEnd: number;
  /** Block content without trailing empty lines. */
  lines: BlockLine[];
}

export interface ParsedDesign {
  blocks: DesignBlock[];
  diagnostics: Diagnostic[];
}

// Parse only: the document is never compiled, evaluated or rendered.
const processor = unified().use(remarkParse).use(remarkMdx);

/** `source` is the document text without a byte order mark. */
export function parseDesignMdx(source: string, file: string): ParsedDesign {
  const starts = lineStarts(source);
  const error = (code: string, message: string, at?: number | Position): Diagnostic => ({
    code,
    severity: "error",
    message,
    file,
    ...(typeof at === "number" ? positionAt(starts, at) : at),
  });

  let tree: Root;
  try {
    tree = processor.parse(source);
  } catch (cause) {
    if (!isParseError(cause)) throw cause;
    return { blocks: [], diagnostics: [error("E_MDX_SYNTAX", cause.reason, parseErrorPosition(cause))] };
  }

  const blocks: DesignBlock[] = [];
  const diagnostics: Diagnostic[] = [];

  const visitCode = (node: Code, topLevel: boolean) => {
    if (node.meta?.trim() !== "design") return;
    const start = node.position!.start.offset!;
    if (node.lang !== "ts") {
      diagnostics.push(
        error("E_DESIGN_BLOCK_MARKER", `Code fence meta "design" is reserved for "ts" blocks, got "${node.lang ?? ""}".`, start),
      );
      return;
    }
    if (!topLevel || node.position!.start.column !== 1) {
      diagnostics.push(
        error("E_DESIGN_BLOCK_LOCATION", "A ts design block must be an unindented fenced block at the top level of the document.", start),
      );
      return;
    }
    if (node.value.trim() === "") {
      diagnostics.push(error("E_DESIGN_BLOCK_EMPTY", "The ts design block is empty.", start));
      return;
    }
    blocks.push({
      order: blocks.length,
      sourceStart: start,
      sourceEnd: node.position!.end.offset!,
      lines: blockLines(source, starts, node),
    });
  };

  const visit = (node: Nodes, topLevel: boolean) => {
    if (node.type === "code") visitCode(node, topLevel);
    else if ("children" in node) for (const child of node.children) visit(child, false);
  };
  for (const child of tree.children) visit(child, true);

  // Misplaced or empty blocks are already reported; do not cascade into "missing".
  if (blocks.length === 0 && diagnostics.length === 0) {
    diagnostics.push(error("E_DESIGN_BLOCK_MISSING", "The design document has no ts design block."));
  }
  return { blocks, diagnostics };
}

/**
 * Pairs the lines of a non-empty, unindented fenced block with their source
 * offsets. Such content starts on the line after the opening fence and is
 * copied verbatim by the parser, which is asserted rather than assumed: a
 * wrong mapping must not pass silently.
 */
function blockLines(source: string, starts: readonly number[], node: Code): BlockLine[] {
  const firstLine = node.position!.start.line;
  const lines = splitLines(node.value).map((line, index): BlockLine => {
    const sourceStart = starts[firstLine + index];
    // The parser replaces NUL with U+FFFD; both are one UTF-16 unit.
    const authored = source.slice(sourceStart, sourceStart + line.text.length).replaceAll("\0", String.fromCharCode(0xfffd));
    if (authored !== line.text) {
      throw new Error(`Design block line ${firstLine + index + 1} does not match the document text.`);
    }
    return { text: line.text, sourceStart };
  });
  while (lines.at(-1)!.text === "") lines.pop();
  return lines;
}

/** The subset of vfile's VFileMessage that the MDX parser throws. */
interface ParseError {
  reason: string;
  place?: { offset?: number; start?: { offset?: number } } | null;
}

function isParseError(value: unknown): value is ParseError {
  return value instanceof Error && typeof (value as Partial<ParseError>).reason === "string";
}

/**
 * `place` is a point for tokenizer errors and a start/end range for JSX tag
 * errors. A tag left open until the end of the document has no `place`; its
 * position is only in the message, as "(line:column-line:column)".
 */
function parseErrorPosition(error: ParseError): number | Position | undefined {
  const offset = error.place?.offset ?? error.place?.start?.offset;
  if (offset !== undefined) return offset;
  const inMessage = /\((\d+):(\d+)-\d+:\d+\)/.exec(error.reason);
  return inMessage ? { line: Number(inMessage[1]), column: Number(inMessage[2]) } : undefined;
}
