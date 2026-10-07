import type ts from "typescript";
import { collectComments } from "./doc-comments.ts";
import type { TypeScript } from "./typescript.ts";

// Source nodes are immutable snapshots. Share the work across contracts, without retaining old projects.
const comments = new WeakMap<ts.SourceFile, ts.CommentRange[]>();
const fileDirectives = new WeakMap<ts.SourceFile, ts.CommentRange[]>();
const normalized = new WeakMap<ts.Node, string>();

function sourceComments(ts: TypeScript, source: ts.SourceFile): ts.CommentRange[] {
  let ranges = comments.get(source);
  if (!ranges) {
    ranges = collectComments(ts, source);
    comments.set(source, ranges);
  }
  return ranges;
}

function fileDirective(text: string): boolean {
  return /@ts-(?:no)?check\b|@jsx\w*\b|^\/\/\/\s*<|\b(?:node:coverage|eslint-disable|biome-ignore-all)\b/.test(text);
}

/** File directives are shared material of every selected declaration, including in excerpts. */
export function fileDirectiveRanges(ts: TypeScript, source: ts.SourceFile): readonly ts.CommentRange[] {
  let ranges = fileDirectives.get(source);
  if (!ranges) {
    ranges = sourceComments(ts, source).filter((range) => fileDirective(source.text.slice(range.pos, range.end)));
    fileDirectives.set(source, ranges);
  }
  return ranges;
}

/** Keep annotations and tool directives conservatively; ordinary prose comments are only context. */
function directive(text: string): boolean {
  return /@|^\/\/\/\s*<|\b(?:node:coverage|istanbul|c8|v8|eslint|jshint|jslint|prettier|biome|webpack\w*|vite|sourceURL|sourceMappingURL)\b|[#]__/.test(text);
}

/** These directives act on source lines, not just the following syntax node. */
function lineDirective(text: string): boolean {
  return /@ts-(?:ignore|expect-error)\b|\b(?:node:coverage|istanbul|c8|v8|eslint|jshint|jslint|biome)\b/.test(text);
}

/**
 * Syntax structure, literal token text and directive attachment, without ordinary comment/spacing trivia.
 * Structure matters: `return\nvalue` and `return value` must never share a fingerprint.
 * Keep the source text separately for packets and legacy fingerprints.
 */
export function codeFingerprintText(ts: TypeScript, node: ts.Node): string {
  const known = normalized.get(node);
  if (known !== undefined) return known;
  const source = node.getSourceFile();
  // Broken syntax has no reliable tree. Conservatively retain its text.
  if ((source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return node.getFullText().trim();
  const tokens: ts.Node[] = [];
  const tree: (string | number)[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isJSDoc(current)) return;
    tree.push(current.kind, "(");
    const children = current.getChildren(source).filter((child) => !ts.isJSDoc(child));
    if (children.length > 0) children.forEach(visit);
    else {
      tokens.push(current);
      tree.push(ts.isJsxText(current) ? source.text.slice(current.pos, current.end) : current.getText(source));
    }
    tree.push(")");
  };
  visit(node);
  const ranges = sourceComments(ts, source);
  const shared = new Set(fileDirectiveRanges(ts, source));
  const selected = ranges.filter((range) => {
    const text = source.text.slice(range.pos, range.end);
    return directive(text) && (range.pos >= node.pos && range.end <= node.end || shared.has(range));
  });
  const annotations = selected.map((range) => {
    const text = source.text.slice(range.pos, range.end);
    const next = tokens.findIndex((token) => token.getStart(source) >= range.end);
    const before = next === -1 ? tokens.at(-1) : tokens[next - 1];
    const after = next === -1 ? node.end : tokens[next].getStart(source);
    const between = source.text.slice(range.end, after);
    return [
      next,
      before ? !/[\r\n]/.test(source.text.slice(before.end, range.pos)) : false,
      lineDirective(text) ? (between.match(/\n/g) ?? []).length : 0,
      // Inserting another comment can detach a Cage tag from its declaration.
      ranges.some((other) => other.pos >= range.end && other.end <= after),
      text,
      // Compiler pragmas only take effect in the file header. A selected node's
      // first token cannot tell whether an earlier, unselected statement precedes them.
      ...(shared.has(range) ? [range.end <= source.getStart(source)] : []),
    ];
  });
  // A line-based suppression can cover two statements on one line but only one after reformatting.
  const lineSensitive = selected.some((range) => lineDirective(source.text.slice(range.pos, range.end)));
  const firstLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const tokenLines = lineSensitive ? tokens.map((token) => source.getLineAndCharacterOfPosition(token.getStart(source)).line - firstLine) : [];
  const result = JSON.stringify([tree, annotations, tokenLines, ts.isSourceFile(node) ? ts.getShebang(source.text) ?? "" : ""]);
  normalized.set(node, result);
  return result;
}
