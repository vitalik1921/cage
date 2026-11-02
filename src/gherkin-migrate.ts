import path from "node:path";
import type ts from "typescript";
import type { Nodes, Root } from "mdast";
import { dialects } from "@cucumber/gherkin";
import { collectDocComments, docCommentBefore, type DocComment } from "./doc-comments.ts";
import { hasErrors, type Diagnostic } from "./diagnostic.ts";
import { lineStarts, positionAt, stripBom } from "./location.ts";
import { parseInvariant } from "./metadata.ts";
import { parseDesignMdx } from "./mdx.ts";
import type { TypeScript } from "./typescript.ts";

export interface MovedRule { contract: string; member: string | null; id: string; text: string }
interface Edit { start: number; end: number; text: string }
export interface MigrationContent { content: string; rules: MovedRule[]; diagnostics: Diagnostic[] }
const apply = (source: string, edits: Edit[]) => edits.sort((a, b) => b.start - a.start).reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
const prose = (node: Nodes): string => node.type === "text" || node.type === "inlineCode" ? node.value : "children" in node ? node.children.map(prose).join("") : "";

/** Move the logical JSDoc sentences that Cage already reads, preserving all other authored content. */
export function migrateContent(ts: TypeScript, original: string, file: string): MigrationContent {
  const source = stripBom(original), starts = lineStarts(source);
  const rules: MovedRule[] = [], diagnostics: Diagnostic[] = [], edits: Edit[] = [];
  const failure = (message: string, offset: number) => diagnostics.push({ code: "E_MIGRATE", severity: "error", message, file, ...positionAt(starts, offset) });
  const result = (content = source): MigrationContent => ({ content, rules, diagnostics });
  let tree: Root | undefined;
  const parsed = parseDesignMdx(source, file, value => { tree = value; });
  diagnostics.push(...parsed.diagnostics);
  if (!tree || hasErrors(diagnostics)) return result();
  for (const block of parsed.blocks) {
    const text = block.lines.map(line => line.text).join("\n"), virtualStarts = lineStarts(text);
    const authored = (offset: number) => { const at = positionAt(virtualStarts, offset); return block.lines[at.line - 1].sourceStart + at.column - 1; };
    const sf = ts.createSourceFile(file + ".ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const handled = new Set<number>();
    const move = (comment: DocComment | undefined, contract: string, member: string | null) => {
      if (!comment) return;
      const removals: Edit[] = [];
      for (let i = 0; i < comment.tags.length; i++) {
        const tag = comment.tags[i];
        if (tag.name !== "invariant") continue;
        handled.add(tag.start);
        const invariant = tag.suffix === "" ? parseInvariant(tag.text) : undefined;
        if (!invariant || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(invariant.id)) { failure("invariant needs a Gherkin-compatible kebab id and sentence; it cannot be renamed automatically", authored(tag.start)); continue; }
        const carrier = contract + (member === null ? "" : `.${member}`);
        if (!/^[A-Z][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)?$/u.test(carrier)) { failure(`cannot express carrier ${carrier} as a Gherkin tag`, authored(tag.start)); continue; }
        rules.push({ contract, member, ...invariant });
        const lineStart = virtualStarts[positionAt(virtualStarts, tag.start).line - 1];
        const start = /^[ \t]*\*?[ \t]*$/.test(text.slice(lineStart, tag.start)) ? lineStart : tag.start;
        const next = comment.tags[i + 1]?.start ?? text.lastIndexOf("*/", comment.end - 1);
        const nextLine = virtualStarts[positionAt(virtualStarts, next).line - 1];
        const end = nextLine > tag.start && /^[ \t]*\**[ \t]*$/.test(text.slice(nextLine, next)) ? nextLine : next;
        removals.push({ start, end, text: "" });
      }
      if (!removals.length) return;
      const remaining = apply(text.slice(comment.pos, comment.end), removals.map(edit => ({ ...edit, start: edit.start - comment.pos, end: edit.end - comment.pos })));
      if (/^\/\*\*[\s*]*\*\/$/.test(remaining)) edits.push({ start: authored(comment.pos), end: authored(comment.end), text: "" });
      else edits.push(...removals.map(edit => ({ ...edit, start: authored(edit.start), end: authored(edit.end) })));
    };
    for (const statement of sf.statements) {
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const comment = docCommentBefore(ts, sf, statement);
      if (!comment?.tags.some(tag => tag.name === "contract" || tag.name === "family")) continue;
      move(comment, statement.name.text, null);
      const members: readonly ts.TypeElement[] = ts.isInterfaceDeclaration(statement) ? statement.members : ts.isTypeLiteralNode(statement.type) ? statement.type.members : [];
      for (const member of members) {
        if (ts.isCallSignatureDeclaration(member)) move(docCommentBefore(ts, sf, member), statement.name.text, null);
        else if ((ts.isMethodSignature(member) || ts.isPropertySignature(member)) && ts.isIdentifier(member.name)) move(docCommentBefore(ts, sf, member), statement.name.text, member.name.text);
      }
    }
    for (const comment of collectDocComments(ts, sf)) for (const tag of comment.tags) if (tag.name === "invariant" && !handled.has(tag.start)) failure("invariant has no supported exported contract/family carrier", authored(tag.start));
  }
  if (hasErrors(diagnostics) || rules.length === 0) return result();
  const existing = parsed.gherkin?.rules.filter(rule => rule.carrier).map(rule => ({ contract: rule.carrier!.contract, member: rule.carrier!.member, id: rule.id, text: rule.text })) ?? [];
  const seen = new Set<string>();
  for (const rule of [...existing, ...rules]) {
    const key = `${rule.contract}.${rule.id}`;
    if (seen.has(key)) failure(`${key} occurs twice; resolve the duplicate before migration`, 0);
    seen.add(key);
  }
  if (hasErrors(diagnostics)) return result();
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const language = parsed.gherkin?.feature.language ?? "en";
  const keyword = dialects[language].rule[0];
  if (!keyword) { failure(`the ${language} dialect has no Rule keyword`, 0); return result(); }
  const indent = " ".repeat((parsed.gherkin?.feature.location.column ?? 1) + 1);
  const rendered = rules.map(rule => `${indent}@${rule.contract}${rule.member === null ? "" : "." + rule.member}${newline}${indent}${keyword}: ${rule.id} — ${rule.text}`).join(newline + newline);
  const block = tree.children.find(node => node.type === "code" && node.lang === "gherkin" && node.meta?.trim() === "design");
  if (block) {
    const start = block.position!.start.offset!, end = block.position!.end.offset!;
    const lastLine = starts[positionAt(starts, end).line - 1];
    const fence = /^(`{3,}|~{3,})/.exec(source.slice(start))![1];
    const closing = new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(source.slice(lastLine, end));
    const at = closing ? lastLine : end;
    edits.push({ start: at, end: at, text: (source.slice(0, at).endsWith(newline) ? newline : newline + newline) + rendered + newline });
  } else {
    const heading = tree.children.find(node => node.type === "heading" && node.depth === 1);
    const title = (heading ? prose(heading) : path.posix.basename(file, ".cage.mdx")).replace(/\s+/g, " ").trim();
    const at = heading?.position!.end.offset ?? 0;
    const trailing = source.slice(at).startsWith(newline + newline) ? "" : source.slice(at).startsWith(newline) ? newline : newline + newline;
    const feature = (heading ? newline + newline : "") + [`\`\`\`gherkin design`, `Feature: ${title || "Design"}`, "", rendered, "```"].join(newline) + trailing;
    edits.push({ start: at, end: at, text: feature });
  }
  const content = apply(source, edits);
  const converted = parseDesignMdx(content, file);
  if (hasErrors(converted.diagnostics)) { failure("the moved text cannot be represented safely in Gherkin; edit the invariant or Feature context first", 0); return result(); }
  const after = converted.gherkin?.rules.filter(rule => rule.carrier).map(rule => ({ contract: rule.carrier!.contract, member: rule.carrier!.member, id: rule.id, text: rule.text })) ?? [];
  if (JSON.stringify(after) !== JSON.stringify([...existing, ...rules])) { failure("migration would change rule identity, binding or logical text", 0); return result(); }
  return result(content);
}

/** A deterministic unified content preview, with common outer context retained; never writes a temporary diff file. */
export function migrationDiff(file: string, before: string, after: string): string {
  const lines = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const a = lines(stripBom(before)), b = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (suffix < Math.min(a.length, b.length) - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), tail = Math.min(3, suffix);
  const output = [`--- a/${file}`, `+++ b/${file}`, `@@ -${start + 1},${a.length - suffix + tail - start} +${start + 1},${b.length - suffix + tail - start} @@`, ...a.slice(start, prefix).map(line => " " + line)];
  const append = (part: string[], marker: string, reachesEnd: boolean, newline: boolean) => {
    output.push(...part.map(line => marker + line));
    if (part.length && reachesEnd && !newline) output.push("\\ No newline at end of file");
  };
  append(a.slice(prefix, a.length - suffix), "-", suffix === 0, /[\r\n]$/.test(before));
  append(b.slice(prefix, b.length - suffix), "+", suffix === 0, /[\r\n]$/.test(after));
  append(a.slice(a.length - suffix, a.length - suffix + tail), " ", suffix === tail, /[\r\n]$/.test(before));
  return output.join("\n") + "\n";
}
