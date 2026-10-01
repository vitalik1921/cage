import type ts from "typescript";
import type { SourceLocation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { BINDING_TAGS, isBindingTag, isDocComment, parseDocTags, tagKind, type DocTag } from "./metadata.ts";
import type { TypeScript } from "./typescript.ts";

/** A `/** ... *\/` comment and the tags in it. */
export interface DocComment {
  /** Offset of the comment in its file. */
  pos: number;
  end: number;
  tags: DocTag[];
}

/** The comments on the line of the token that ends at `position`. The start of the file has no previous token. */
function commentsEndingLine(ts: TypeScript, text: string, position: number): ts.CommentRange[] {
  return position === 0 ? [] : (ts.getTrailingCommentRanges(text, position) ?? []);
}

/** The comments between the previous token and `position`, where a token or the end of the file starts. */
function commentsBefore(ts: TypeScript, text: string, position: number): ts.CommentRange[] {
  return [...commentsEndingLine(ts, text, position), ...(ts.getLeadingCommentRanges(text, position) ?? [])];
}

/** Every comment of a file. Comments are trivia of tokens, so each one precedes a token or the end of the file. */
export function collectComments(ts: TypeScript, sourceFile: ts.SourceFile): ts.CommentRange[] {
  const text = sourceFile.text;
  const comments = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node) => {
    // A doc comment is itself a child node of what it precedes; its content is not tokens of the program.
    if (ts.isJSDoc(node)) return;
    if (ts.isToken(node)) for (const range of commentsBefore(ts, text, node.getFullStart())) comments.set(range.pos, range);
    node.getChildren(sourceFile).forEach(visit);
  };
  visit(sourceFile);
  return [...comments.values()].sort((a, b) => a.pos - b.pos);
}

/** The doc comments of a file, with their tags. */
export function collectDocComments(ts: TypeScript, sourceFile: ts.SourceFile): DocComment[] {
  return collectComments(ts, sourceFile)
    .map((range) => ({ range, text: sourceFile.text.slice(range.pos, range.end) }))
    .filter(({ text }) => isDocComment(text))
    .map(({ range, text }) => ({ pos: range.pos, end: range.end, tags: parseDocTags(text, range.pos) }));
}

/**
 * The doc comment directly before a node: only whitespace may separate them.
 * Another comment in between breaks the binding, and a comment that ends the
 * line of the previous declaration is about that declaration, not this node.
 */
export function docCommentBefore(ts: TypeScript, sourceFile: ts.SourceFile, node: ts.Node): DocComment | undefined {
  const text = sourceFile.text;
  const start = node.getStart(sourceFile);
  const last = commentsBefore(ts, text, node.getFullStart()).at(-1);
  if (!last || !isDocComment(text.slice(last.pos, last.end))) return undefined;
  const endsPreviousLine = commentsEndingLine(ts, text, node.getFullStart()).some((range) => range.pos === last.pos) && /[\r\n]/.test(text.slice(last.end, start));
  if (endsPreviousLine) return undefined;
  return { pos: last.pos, end: last.end, tags: parseDocTags(text.slice(last.pos, last.end), last.pos) };
}

/**
 * Checks the tags of one doc comment against the harness tags allowed at its
 * place and returns the allowed ones by name. Standard JSDoc tags are left
 * alone; `@ts-*` comments are the business of whoever reads the file.
 */
/**
 * A binding tag written inside the text of another binding tag, as in
 * `@tests Quota @covers empty`: the second one was meant as a tag. Prose
 * of a design may mention a tag mid-sentence; only the three tags of the
 * code's side take names, not sentences, so only they are judged.
 */
function inlineTag(name: string, text: string): string | undefined {
  if (!BINDING_TAGS.has(name)) return undefined;
  const found = /(?:^|\s)@([a-z-]+)(?=\s|$)/.exec(text);
  return found && BINDING_TAGS.has(found[1]) ? found[1] : undefined;
}

export function readAllowedTags(
  tags: readonly DocTag[],
  allowed: readonly string[],
  where: string,
  report: (code: string, message: string, offset: number) => void,
): Map<string, DocTag[]> {
  const byName = new Map<string, DocTag[]>();
  for (const tag of tags) {
    const kind = tagKind(tag.name);
    if (kind === "standard" || /^ts-/i.test(tag.name)) continue;
    if (kind === "unknown") report("E_UNKNOWN_TAG", `Unknown tag \`@${tag.name}\`.`, tag.start);
    else if (kind === "unsupported") report("E_UNSUPPORTED_TAG", `\`@${tag.name}\` is not supported.`, tag.start);
    else if (!allowed.includes(tag.name)) report("E_TAG_LOCATION", `\`@${tag.name}\` is not allowed ${where}.`, tag.start);
    else if (tag.suffix !== "") report("E_TAG_FORMAT", `\`@${tag.name}${tag.suffix}\`: a space must follow the tag name.`, tag.start);
    else if (inlineTag(tag.name, tag.text)) report("E_TAG_FORMAT", `\`@${inlineTag(tag.name, tag.text)}\` starts a new line of the comment: one tag per line.`, tag.start);
    else byName.set(tag.name, [...(byName.get(tag.name) ?? []), tag]);
  }
  return byName;
}

/**
 * Harness tags in doc comments that are bound to nothing: a recognised tag in
 * the wrong place is reported, never skipped. Comments without a binding tag
 * are ordinary documentation and are left alone.
 */
export function reportUnboundTags(
  comments: readonly DocComment[],
  bound: ReadonlySet<number>,
  where: string,
  report: (code: string, message: string, offset: number) => void,
): void {
  for (const comment of comments) {
    if (bound.has(comment.pos) || !comment.tags.some((tag) => isBindingTag(tag.name))) continue;
    readAllowedTags(comment.tags, ["description"], where, report);
  }
}

/** Locations in an ordinary source file, and errors reported at them. `file` is the project-relative path. */
export function createReporter(ts: TypeScript, sourceFile: ts.SourceFile, file: string, diagnostics: Diagnostic[]) {
  const locate = (offset: number): SourceLocation => {
    const { line, character } = ts.getLineAndCharacterOfPosition(sourceFile, offset);
    return { file, line: line + 1, column: character + 1 };
  };
  const report = (code: string, message: string, offset: number) => {
    diagnostics.push({ code, severity: "error", message, ...locate(offset) });
  };
  return { locate, report };
}
