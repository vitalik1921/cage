import fs from "node:fs";
import path from "node:path";
import type { Root } from "mdast";
import type { DesignPhaseOptions, DesignPhaseResult } from "./design-phase.ts";
import { compareDiagnostics, type Diagnostic, type RelatedLocation } from "./diagnostic.ts";
import { CORE_LINT_CODES, defaultLint, type CoreLintCode, type LintConfig } from "./lint-config.ts";
import { lintModel, type LintDocument, type LintText } from "./lint-model.ts";
import { positionAt, stripBom, toProjectPath } from "./location.ts";
import { parseDesignMdx } from "./mdx.ts";
import { loadTypeScript } from "./typescript.ts";

// Explicit retrospective notation, not ordinary tense or a bare business date.
const history = [
  /(?:^|\n)\s*[*_]*(?:settled|resolved|superseded|decided|done)[*_]*\s*[:—-]/iu,
  /\buser decision\b/iu,
  /(?:^|\n)\s*20\d{2}-\d{2}-\d{2}\s*(?:[:—]| - )(?:\s|$)/u,
  /\b(?:settled|resolved|superseded|decided|changed|added|removed)\s+(?:on\s+)?20\d{2}-\d{2}-\d{2}\b/iu,
  /\b(?=[a-f\d]{7,40}\b)(?=[a-f\d]*\d)(?=[a-f\d]*[a-f])[a-f\d]+\b/iu,
];
const at = (doc: LintDocument, offset: number) => ({ file: doc.file, ...positionAt(doc.starts, offset) });
const settled = (text: string) => /^[*_]*(?:settled|resolved|decided|superseded|done)\b[*_]*/iu.exec(text);
const stem = (file: string) => path.posix.basename(file).replace(/\.cage\.mdx$/, "");

/** Run core lint with syntax alone; the returned null index makes unchecked work explicit. */
export function checkLint(options: DesignPhaseOptions, config: false | LintConfig = defaultLint): DesignPhaseResult {
  const { ts, info } = loadTypeScript(options.root);
  const diagnostics: Diagnostic[] = [...options.problems ?? []];
  const result: DesignPhaseResult = { modules: [], index: null, typescript: info, diagnostics };
  if (diagnostics.length || config === false) return result;
  if (!options.designs.length) {
    diagnostics.push({ code: "E_NO_DESIGNS", severity: "error", message: `no *.cage.mdx matches ${options.designPatterns?.length ? options.designPatterns.join(", ") : "the designs patterns"}` });
    return result;
  }
  const documents: LintDocument[] = [];
  for (const module of options.designs) for (const file of module.sourceFiles) {
    const relative = toProjectPath(options.root, file);
    let source: string;
    try { source = stripBom(options.documents?.get(file) ?? fs.readFileSync(file, "utf8")); }
    catch (cause) { diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", file: relative, message: `cannot read the design document: ${cause instanceof Error ? cause.message : String(cause)}` }); continue; }
    let tree: Root | undefined;
    const parsed = parseDesignMdx(source, relative, value => { tree = value; });
    diagnostics.push(...parsed.diagnostics);
    // Do not audit suppressions or partial declarations from an unparseable document.
    if (tree && !parsed.diagnostics.some(diagnostic => diagnostic.severity === "error")) documents.push(lintModel(ts, relative, module.moduleId, source, tree, parsed));
  }
  documents.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  diagnostics.push(...lintDocuments(documents, config));
  diagnostics.sort(compareDiagnostics);
  return result;
}

export function lintDocuments(documents: readonly LintDocument[], config: LintConfig): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const warn = (code: CoreLintCode, message: string, doc: LintDocument, start: number, related?: RelatedLocation[]) => {
    const level = config.severity[code] ?? "warn";
    if (level !== "off") diagnostics.push({ code, severity: level === "error" ? "error" : "warning", message, ...at(doc, start), ...(related ? { related } : {}) });
  };
  const patterns = [...history, ...config.historyPatterns.map(pattern => new RegExp(pattern, "iu"))];
  for (const doc of documents) {
    const settledLines = new Set(doc.sections.filter(section => /^Open questions/i.test(section.name)).flatMap(section => section.items.filter(item => settled(item.text)).map(item => positionAt(doc.starts, item.start).line)));
    for (const unit of doc.history) {
      const status = settledLines.has(positionAt(doc.starts, unit.start).line) ? settled(unit.text) : null;
      // Status ownership is decided before suppression/severity: suppressing the question cannot resurrect history.
      const historical = patterns.some(pattern => [...unit.text.matchAll(new RegExp(pattern.source, "giu"))].some(match => !status || match.index >= status[0].length));
      if (historical) warn("W_HISTORY_REFERENCE", "historical notation belongs in git or the review record", doc, unit.start);
    }
    for (const section of doc.sections) {
      if (/^Open questions/i.test(section.name)) for (const item of section.items) {
        if (settled(item.text)) warn("W_OPEN_QUESTION_SETTLED", `settled Open question ${item.number}`, doc, item.start);
      }
      const bad = section.items.findIndex((item, index) => item.number !== String(index + 1));
      if (bad !== -1) warn("W_NUMBERING", `${section.name}: expected ${bad + 1}, found ${section.items[bad].number}`, doc, section.items[bad].start);
    }
    for (const invariant of doc.invariants) checkReferences(doc, invariant, documents, warn);
    for (const declaration of doc.declarations.filter(declaration => declaration.kind !== "data")) {
      const rules = declaration.rules + documents.filter(other => other.module === doc.module).flatMap(other => other.gherkinCarriers).filter(name => name === declaration.name).length;
      const exceeded = [declaration.members > config.limits.membersPerContract ? `${declaration.members} members (limit ${config.limits.membersPerContract})` : "", rules > config.limits.rulesPerContract ? `${rules} rules (limit ${config.limits.rulesPerContract})` : ""].filter(Boolean);
      if (exceeded.length) warn("W_CONTRACT_SIZE", `${declaration.name}: ${exceeded.join(", ")}`, doc, declaration.start);
    }
  }
  for (const module of new Set(documents.map(doc => doc.module))) {
    const contracts = documents.filter(doc => doc.module === module).flatMap(doc => doc.declarations.filter(declaration => declaration.kind === "contract").map(declaration => ({ doc, declaration })));
    if (contracts.length > config.limits.contractsPerModule) warn("W_MODULE_SIZE", `${module}: ${contracts.length} contracts (limit ${config.limits.contractsPerModule})`, contracts[0].doc, contracts[0].declaration.start);
  }
  const types = new Map<string, { doc: LintDocument; start: number }[]>();
  for (const doc of documents) for (const declaration of doc.declarations) if (declaration.kind === "data") types.set(declaration.name, [...types.get(declaration.name) ?? [], { doc, start: declaration.start }]);
  for (const [name, places] of types) if (new Set(places.map(place => place.doc.module)).size > 1) {
    warn("W_TYPE_DUPLICATE", `${name} is declared in several modules`, places[0].doc, places[0].start, places.slice(1).map(place => ({ message: "other declaration", ...at(place.doc, place.start) })));
  }
  return suppress(documents, config, diagnostics);
}

function checkReferences(doc: LintDocument, invariant: LintText, documents: readonly LintDocument[], warn: (code: CoreLintCode, message: string, doc: LintDocument, start: number) => void): void {
  for (const parenthetical of invariant.text.matchAll(/\(([^()]*)\)/gu)) {
    const citation = /^(?:(\S+)\s+)?rules?\s+(.+)$/iu.exec(parenthetical[1]);
    if (!citation) continue;
    const numbers: string[] = [];
    let rest = citation[2];
    while (true) {
      const number = /^(\d+[a-z]?)(?=\s|,|[.;]|$)/iu.exec(rest);
      if (!number) break;
      numbers.push(number[1]);
      rest = rest.slice(number[0].length);
      const separator = /^\s*(?:,\s*(?:and\s+)?|and\s+)/iu.exec(rest);
      if (!separator) break;
      rest = rest.slice(separator[0].length);
    }
    let target: LintDocument | undefined = doc;
    if (citation[1]) {
      const named = documents.filter(candidate => stem(candidate.file) === citation[1]);
      const local = named.filter(candidate => candidate.module === doc.module);
      const candidates = local.length ? local : named;
      target = candidates.length === 1 ? candidates[0] : undefined;
    }
    for (const number of new Set(numbers)) {
      const exists = target?.sections.filter(section => /^Business rules/i.test(section.name)).some(section => section.items.some(item => item.number === number));
      if (!exists) warn("W_RULE_REFERENCE_UNKNOWN", `(${citation[1] ? citation[1] + " " : ""}rule ${number}) has no unique numbered business rule`, doc, invariant.start);
    }
  }
}

function suppress(documents: readonly LintDocument[], config: LintConfig, diagnostics: Diagnostic[]): Diagnostic[] {
  const remaining = new Set(diagnostics);
  const audit: Diagnostic[] = [];
  for (const doc of documents) for (const directive of doc.suppressions) {
    const parsed = /^cage-lint-disable\s+(W_[A-Z_]+)\s*:\s*(\S[\s\S]*)$/.exec(directive.text);
    if (!parsed || !CORE_LINT_CODES.includes(parsed[1] as CoreLintCode)) {
      audit.push({ code: "E_TAG_FORMAT", severity: "error", message: "cage-lint-disable needs one core lint code and a non-empty reason after ':'", ...at(doc, directive.start) });
      continue;
    }
    let used = false;
    for (const diagnostic of remaining) {
      if (diagnostic.code !== parsed[1] || !directive.target) continue;
      const matches = [diagnostic, ...diagnostic.related ?? []].some(place => {
        if (place.file !== doc.file || place.line === undefined) return false;
        const offset = doc.starts[place.line - 1] + (place.column ?? 1) - 1;
        return directive.target!.start <= offset && offset < directive.target!.end;
      });
      if (matches) { remaining.delete(diagnostic); used = true; }
    }
    const level = config.severity.W_LINT_SUPPRESSION_UNUSED ?? "warn";
    if (!used && level !== "off") audit.push({ code: "W_LINT_SUPPRESSION_UNUSED", severity: level === "error" ? "error" : "warning", message: `${parsed[1]} suppression silences nothing`, ...at(doc, directive.start) });
  }
  return [...remaining, ...audit];
}
