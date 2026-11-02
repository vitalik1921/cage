import { AstBuilder, dialects, Errors, GherkinClassicTokenMatcher, Parser } from "@cucumber/gherkin";
import type { SourceLocation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { lineStarts, positionAt } from "./location.ts";
import type { DesignBlock } from "./mdx.ts";

type Ast = ReturnType<Parser<unknown>["parse"]>;
export type GherkinFeature = NonNullable<Ast["feature"]>;
export type GherkinRuleNode = NonNullable<GherkinFeature["children"][number]["rule"]>;
export type GherkinExample = NonNullable<GherkinRuleNode["children"][number]["scenario"]>;
type Background = NonNullable<GherkinRuleNode["children"][number]["background"]>;
type Step = GherkinExample["steps"][number];
type Tag = GherkinFeature["tags"][number];
type TableRow = NonNullable<Step["dataTable"]>["rows"][number];

export interface GherkinRule {
  id: string;
  text: string;
  carrier: { contract: string; member: string | null; location: SourceLocation } | null;
  property: boolean;
  assumption: boolean;
  location: SourceLocation;
  /** Parsed descriptions, steps, arguments and labels; every location is in the MDX. */
  node: GherkinRuleNode;
  examples: GherkinExample[];
}

export interface GherkinDesign {
  /** Complete authored block, fences and comments included; never used as TypeScript. */
  source: string;
  location: SourceLocation;
  feature: GherkinFeature;
  comments: { text: string; location: SourceLocation }[];
  rules: GherkinRule[];
}

/** Shared title identity; no runtime case expansion or evidence claim. */
export const normalizeExampleTitle = (title: string): string => title.trim().replace(/\s+/gu, " ").toLowerCase();

// These spellings suggest enforcement or old Cage semantics, so they cannot be free labels.
const reserved = new Set(["@final", "@extendable", "@live", "@contract", "@family", "@data", "@invariant", "@uses", "@implements", "@implements-static", "@tests", "@covers", "@package-instance"]);
const carrierPattern = /^@([A-Z][\p{ID_Continue}$]*)(?:\.([\p{ID_Start}_$][\p{ID_Continue}$]*))?$/u;

/** Parse Gherkin, without compiling pickles or executing any step. IDs restart per document. */
export function parseGherkin(source: string, file: string, block: DesignBlock): { design?: GherkinDesign; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const starts = lineStarts(source);
  const blockLocation = { file, ...positionAt(starts, block.sourceStart) };
  const locate = (at: { line: number; column?: number }): SourceLocation => {
    const line = block.lines[at.line - 1];
    if (!line) {
      const first = block.lines[0];
      if (!first) return blockLocation;
      // EOF is the next authored line (usually the closing fence), not the last token's end.
      return { file, line: Math.min(positionAt(starts, first.sourceStart).line + at.line - 1, positionAt(starts, block.sourceEnd).line), column: at.column ?? 1 };
    }
    // Gherkin token columns count Unicode code points; Cage columns count UTF-16 units.
    const column = [...line.text].slice(0, Math.max(0, (at.column ?? 1) - 1)).join("").length;
    return { file, ...positionAt(starts, line.sourceStart + column) };
  };
  const report = (code: string, message: string, at: SourceLocation) => diagnostics.push({ code, severity: "error", message, ...at });
  let ast: Ast;
  try {
    let id = 0;
    ast = new Parser(new AstBuilder(() => String(id++)), new GherkinClassicTokenMatcher()).parse(block.lines.map(line => line.text).join("\n"));
  } catch (cause) {
    if (!(cause instanceof Errors.GherkinException)) throw cause;
    const errors = cause instanceof Errors.CompositeParserException ? cause.errors : [cause];
    for (const error of errors) {
      report("E_GHERKIN_SYNTAX", error.message.replace(/^\(-?\d+:-?\d+\):\s*/, ""), error instanceof Errors.GherkinException && error.location ? locate(error.location) : blockLocation);
    }
    return { diagnostics };
  }
  if (!ast.feature) {
    report("E_GHERKIN_SYNTAX", "gherkin design block has no Feature", blockLocation);
    return { diagnostics };
  }

  const tagsAt = (tags: readonly Tag[]) => tags.map(tag => ({ ...tag, location: locate(tag.location) }));
  // The parser's table scanner uses UTF-16 columns, unlike its tag scanner.
  const rowAt = (row: TableRow): TableRow => ({ ...row, location: locate(row.location), cells: row.cells.map(cell => ({ ...cell, location: { ...locate({ line: cell.location.line }), column: cell.location.column ?? 1 } })) });
  const stepAt = (step: Step): Step => ({
    ...step, location: locate(step.location),
    ...(step.dataTable ? { dataTable: { ...step.dataTable, location: locate(step.dataTable.location), rows: step.dataTable.rows.map(rowAt) } } : {}),
    ...(step.docString ? { docString: { ...step.docString, location: locate(step.docString.location) } } : {}),
  });
  const backgroundAt = (background: Background): Background => ({ ...background, location: locate(background.location), steps: background.steps.map(stepAt) });
  const exampleAt = (example: GherkinExample): GherkinExample => ({
    ...example, location: locate(example.location), tags: tagsAt(example.tags), steps: example.steps.map(stepAt),
    examples: example.examples.map(table => ({
      ...table, location: locate(table.location), tags: tagsAt(table.tags),
      ...(table.tableHeader ? { tableHeader: rowAt(table.tableHeader) } : {}), tableBody: table.tableBody.map(rowAt),
    })),
  });
  const feature: GherkinFeature = {
    ...ast.feature, location: locate(ast.feature.location), tags: tagsAt(ast.feature.tags),
    children: ast.feature.children.map(child => ({
      ...(child.background ? { background: backgroundAt(child.background) } : {}),
      ...(child.scenario ? { scenario: exampleAt(child.scenario) } : {}),
      ...(child.rule ? { rule: {
        ...child.rule, location: locate(child.rule.location), tags: tagsAt(child.rule.tags),
        children: child.rule.children.map(nested => ({
          ...(nested.background ? { background: backgroundAt(nested.background) } : {}),
          ...(nested.scenario ? { scenario: exampleAt(nested.scenario) } : {}),
        })),
      } } : {}),
    })),
  };
  const location = (node: { location: { line: number; column?: number } }): SourceLocation => ({ file, line: node.location.line, column: node.location.column ?? 1 });
  const readTags = (tags: readonly Tag[], scope: "Feature" | "Rule" | "Example") => {
    const before = diagnostics.length;
    const carriers: NonNullable<GherkinRule["carrier"]>[] = [];
    let property = false;
    let assumption = false;
    for (const tag of tags) {
      const carrier = carrierPattern.exec(tag.name);
      if (carrier && scope !== "Example") carriers.push({ contract: carrier[1], member: carrier[2] ?? null, location: location(tag) });
      else if ((tag.name === "@property" || tag.name === "@assumption") && scope === "Rule") {
        const repeated = tag.name === "@property" ? property : assumption;
        if (repeated) report("E_TAG_FORMAT", tag.name + " occurs twice on a Rule", location(tag));
        if (tag.name === "@property") property = true;
        else assumption = true;
      } else if (reserved.has(tag.name) || tag.name === "@property" || tag.name === "@assumption" || !/^@[a-z][a-z0-9_-]*$/.test(tag.name)) {
        report("E_GHERKIN_UNSUPPORTED", tag.name + " is not supported on a " + scope, location(tag));
      }
    }
    return { carriers, property, assumption, invalid: diagnostics.length > before };
  };
  const defaults = readTags(feature.tags, "Feature");
  if (defaults.carriers.length > 1) report("E_RULE_UNBOUND", "Feature has more than one default carrier", defaults.carriers[1].location);
  const rules: GherkinRule[] = [];
  for (const child of feature.children) {
    if (child.scenario) report("E_GHERKIN_UNSUPPORTED", "an Example must belong to a Rule", location(child.scenario));
    if (!child.rule) continue;
    const node = child.rule;
    const found = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*) (?:—|-) (\S.*)$/u.exec(node.name);
    if (!found) report("E_RULE_FORMAT", node.name, location(node));
    const flags = readTags(node.tags, "Rule");
    const carriers = flags.carriers.length > 0 ? flags.carriers : flags.assumption ? [] : defaults.carriers;
    // A rejected tag or Feature default already explains why its rules cannot bind.
    const checkBinding = !flags.invalid && (flags.carriers.length > 0 || flags.assumption || !defaults.invalid && defaults.carriers.length <= 1);
    if (checkBinding && flags.assumption && (flags.carriers.length > 0 || flags.property)) report("E_RULE_UNBOUND", "an assumption has no carrier or @property flag", location(node));
    else if (checkBinding && !flags.assumption && carriers.length !== 1) report("E_RULE_UNBOUND", node.name + ": expected one carrier", location(node));
    const examples = node.children.flatMap(nested => nested.scenario ? [nested.scenario] : []);
    const titles = new Map<string, SourceLocation>();
    for (const example of examples) {
      readTags(example.tags, "Example");
      const title = normalizeExampleTitle(example.name);
      if (!title) report("E_GHERKIN_UNSUPPORTED", "an Example needs a title", location(example));
      else if (titles.has(title)) diagnostics.push({ code: "E_EXAMPLE_DUPLICATE", severity: "error", message: example.name, ...location(example), related: [{ message: "the other Example", ...titles.get(title)! }] });
      else titles.set(title, location(example));
      const outline = dialects[feature.language].scenarioOutline.includes(example.keyword);
      if (outline && (example.examples.length === 0 || example.examples.some(table => !table.tableHeader || table.tableBody.length === 0))) report("E_GHERKIN_UNSUPPORTED", "a Scenario Outline needs Examples with data rows", location(example));
      if (!outline && example.examples.length > 0) report("E_GHERKIN_UNSUPPORTED", "Examples tables belong to a Scenario Outline", location(example));
      for (const table of example.examples) readTags(table.tags, "Example");
    }
    if (found) rules.push({ id: found[1], text: found[2], carrier: flags.assumption ? null : carriers[0] ?? null, property: flags.property, assumption: flags.assumption, location: location(node), node, examples });
  }
  return { design: { source: source.slice(block.sourceStart, block.sourceEnd), location: blockLocation, feature, comments: ast.comments.map(comment => ({ text: comment.text, location: locate(comment.location) })), rules }, diagnostics };
}
