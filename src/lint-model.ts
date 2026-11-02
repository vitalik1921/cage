import type { Nodes, Root } from "mdast";
import { docCommentBefore, type DocComment } from "./doc-comments.ts";
import type { GherkinDesign } from "./gherkin.ts";
import { lineStarts, positionAt } from "./location.ts";
import type { ParsedDesign } from "./mdx.ts";
import type { TypeScript } from "./typescript.ts";

export interface Span { start: number; end: number }
export interface LintText { text: string; start: number }
export interface NumberedItem extends LintText { number: string }
export interface LintDeclaration { name: string; kind: "contract" | "family" | "data"; start: number; members: number; rules: number }
export interface Suppression { text: string; start: number; target?: Span }
export interface LintDocument {
  file: string; module: string; source: string; starts: number[];
  history: LintText[]; invariants: LintText[];
  sections: { name: string; items: NumberedItem[] }[];
  declarations: LintDeclaration[]; suppressions: Suppression[]; gherkinCarriers: string[];
}

const span = (node: Nodes): Span => ({ start: node.position!.start.offset!, end: node.position!.end.offset! });
const inside = (offset: number, ranges: Span[]) => ranges.some(range => range.start <= offset && offset < range.end);
const directive = (text: string) => /^\s*\{\/\*\s*cage-lint-disable\b/.test(text);

/** Syntax and source ranges only: no compiler program, symbol lookup or inherited declarations. */
export function lintModel(ts: TypeScript, file: string, module: string, source: string, tree: Root, parsed: ParsedDesign): LintDocument {
  const starts = lineStarts(source);
  const doc: LintDocument = { file, module, source, starts, history: [], invariants: [], sections: [], declarations: [], suppressions: [], gherkinCarriers: [] };
  const excluded: Span[] = [];
  const nestedLists: Span[] = [];
  const excludedNode = (node: Nodes) => node.type === "code" || node.type === "table" || node.type === "mdxFlowExpression" || node.type === "mdxTextExpression" || node.type === "mdxjsEsm";
  const ranges = (node: Nodes, listDepth = 0) => {
    if (excludedNode(node)) { excluded.push(span(node)); return; }
    if (node.type === "list" && listDepth > 0) nestedLists.push(span(node));
    if ("children" in node) for (const child of node.children) ranges(child, listDepth + (node.type === "list" ? 1 : 0));
  };
  ranges(tree);
  const visit = (node: Nodes) => {
    if (excludedNode(node)) return;
    if (node.type === "paragraph" || node.type === "heading") {
      const range = span(node);
      // GFM tables are plain paragraphs in an MDX parser without the GFM extension.
      if (/^\s*\|?\s*:?-{3,}:?\s*\|/m.test(source.slice(range.start, range.end))) { excluded.push(range); return; }
      let prose = source.slice(range.start, range.end);
      for (const hidden of excluded.filter(hidden => hidden.start >= range.start && hidden.end <= range.end)) {
        const start = hidden.start - range.start, end = hidden.end - range.start;
        prose = prose.slice(0, start) + prose.slice(start, end).replace(/[^\r\n]/g, " ") + prose.slice(end);
      }
      for (const part of prose.matchAll(/[^\r\n]+/g)) {
        if (!/^\s*\|/.test(part[0]) && !/^\s*:?-{3,}/.test(part[0])) doc.history.push({ text: node.type === "heading" ? part[0].replace(/^#{1,6}\s+/, "") : part[0], start: range.start + part.index });
      }
    }
    if ("children" in node) {
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        const text = source.slice(span(child).start, span(child).end);
        if (child.type === "mdxFlowExpression" && directive(text)) {
          const next = node.children.slice(i + 1).find(sibling => !(sibling.type === "mdxFlowExpression" && directive(source.slice(span(sibling).start, span(sibling).end))));
          doc.suppressions.push({ text: text.replace(/^\s*\{\/\*\s*/, "").replace(/\s*\*\/\}\s*$/, ""), start: span(child).start, ...(next ? { target: span(next) } : {}) });
        }
        visit(child);
      }
    }
  };
  visit(tree);

  const headings = tree.children.filter(node => node.type === "heading" && node.depth === 2);
  headings.forEach((heading, i) => {
    const name = source.slice(span(heading).start, span(heading).end).replace(/^##\s*/, "").trim();
    if (!/^(Business rules|Open questions)(?:$|\s)/i.test(name)) return;
    const end = headings[i + 1] ? span(headings[i + 1]).start : source.length;
    const items: NumberedItem[] = [];
    for (const line of source.slice(span(heading).end, end).matchAll(/[^\r\n]+/g)) {
      const start = span(heading).end + line.index;
      const match = /^( {0,3})(\d+[a-z]?|[a-z])[.)]\s+(.*)$/i.exec(line[0]);
      if (!match) continue;
      const itemStart = start + match[1].length;
      if (!inside(itemStart, excluded) && !inside(itemStart, nestedLists)) items.push({ number: match[2], text: match[3], start: itemStart });
    }
    doc.sections.push({ name, items });
  });

  for (const block of parsed.blocks) {
    const text = block.lines.map(line => line.text).join("\n");
    const virtualStarts = lineStarts(text);
    const authored = (offset: number) => {
      const at = positionAt(virtualStarts, offset);
      return block.lines[at.line - 1].sourceStart + at.column - 1;
    };
    const sf = ts.createSourceFile(file + ".ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const addTags = (comment: DocComment | undefined) => {
      for (const tag of comment?.tags ?? []) {
        if (tag.name !== "invariant" && tag.name !== "description") continue;
        const unit = { text: tag.name === "invariant" ? tag.text.replace(/^\S+\s+/, "") : tag.text, start: authored(tag.start) };
        doc.history.push(unit);
        if (tag.name === "invariant") doc.invariants.push(unit);
      }
    };
    for (const statement of sf.statements) {
      if (!(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) || !statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      const comment = docCommentBefore(ts, sf, statement);
      const kind = comment?.tags.find(tag => ["contract", "family", "data"].includes(tag.name))?.name as LintDeclaration["kind"] | undefined;
      if (!kind) continue;
      const before = doc.invariants.length;
      addTags(comment);
      const members = ts.isInterfaceDeclaration(statement) ? statement.members : ts.isTypeLiteralNode(statement.type) ? statement.type.members : [];
      for (const member of members) addTags(docCommentBefore(ts, sf, member));
      doc.declarations.push({ name: statement.name.text, kind, start: authored(statement.name.getStart(sf)), members: members.length, rules: doc.invariants.length - before });
    }
  }
  if (parsed.gherkin) addGherkin(doc, parsed.gherkin);
  return doc;
}

function addGherkin(doc: LintDocument, design: GherkinDesign): void {
  const offset = (location: { line: number; column?: number }) => doc.starts[location.line - 1] + (location.column ?? 1) - 1;
  const startOf = (node: { location: { line: number; column?: number }; tags?: readonly { location: { line: number; column?: number } }[] }) => Math.min(offset(node.location), ...(node.tags ?? []).map(tag => offset(tag.location)));
  const end = doc.starts[design.location.line - 1] + design.source.length;
  const targets = design.rules.flatMap(rule => [rule.node, ...rule.examples]).sort((a, b) => startOf(a) - startOf(b));
  for (const comment of design.comments) {
    const text = comment.text.replace(/^\s*#\s*/, "");
    if (!/^cage-lint-disable\b/.test(text)) continue;
    const start = offset(comment.location);
    const next = targets.find(node => startOf(node) > start);
    if (!next) { doc.suppressions.push({ text, start }); continue; }
    const rule = design.rules.find(rule => rule.node === next);
    const siblings = rule ? design.rules.map(rule => rule.node) : targets;
    const following = siblings.find(node => startOf(node) > startOf(next));
    doc.suppressions.push({ text, start, target: { start: startOf(next), end: following ? startOf(following) : end } });
  }
  // Only the Feature/Rule names and descriptions. Steps, tables, doc strings and Examples are cases, not history.
  const add = (node: { name: string; description: string; location: { line: number; column?: number } }) => {
    doc.history.push({ text: node.name, start: offset(node.location) });
    if (node.description) doc.history.push({ text: node.description, start: doc.starts[node.location.line] ?? offset(node.location) });
  };
  add(design.feature);
  for (const rule of design.rules) {
    add({ ...rule.node, name: rule.text });
    if (rule.carrier) doc.gherkinCarriers.push(rule.carrier.contract);
    if (!rule.assumption) doc.invariants.push({ text: rule.text, start: offset(rule.location) });
  }
}
