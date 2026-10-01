import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { Contract, Edge, Implementation, SourceLocation, TestDeclaration } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import { compareText, type Diagnostic } from "./diagnostic.ts";
import type { ImplementationPhaseResult } from "./implementation-phase.ts";
import { stripBom, toProjectPath } from "./location.ts";
import type { Overlay, TypeScript } from "./typescript.ts";

/** A file the reviewer reads, once, whatever number of contracts it serves. Its text has `\n` line endings whatever the disk has. */
export interface PacketFile {
  path: string;
  /** "helper": a project file a test file imports, loaded because a reviewer has to see what a stub stands in for. */
  role: "design" | "implementation" | "test" | "helper";
  text: string;
  /** Of the normalized text, so that the line endings of a checkout do not count as a change. */
  digest: string;
}

/** The files a contract's review is made of, and what they were found for. */
/** One piece of what a review of a contract is about: the contract itself, an implementation, a test. */
export interface MaterialPart {
  /** `contract`, `implementation <file>#<name>` or `test <file>:<title>`. */
  key: string;
  text: string;
}

export interface Material {
  contract: Contract;
  own: DesignModule;
  dependencyDesigns: string[];
  uses: { contract: string; module: string }[];
  usedBy: { contract: string; module: string }[];
  implementations: Implementation[];
  declarations: TestDeclaration[];
  testFiles: string[];
  files: PacketFile[];
  /** What the fingerprint is made of: the contract's declaration, the text of each implementation, the text of each test declared for it. */
  parts: MaterialPart[];
}

export type FileReader = (file: string, role: PacketFile["role"], text?: string) => PacketFile | undefined;

/** A reader that loads each file once and reports what cannot be read. */
export function createFileReader(root: string, diagnostics: Diagnostic[]): { read: FileReader; files: Map<string, PacketFile> } {
  const files = new Map<string, PacketFile>();
  const read: FileReader = (file, role, text) => {
    const known = files.get(file);
    if (known) return known;
    try {
      const normalized = (text ?? stripBom(fs.readFileSync(path.join(root, file), "utf8"))).replace(/\r\n?/g, "\n");
      const loaded = { path: file, role, text: normalized, digest: digestOf(normalized) };
      files.set(file, loaded);
      return loaded;
    } catch (cause) {
      diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot read a file of the review: ${(cause as Error).message}`, file });
      return undefined;
    }
  };
  return { read, files };
}

/**
 * Collects what a reviewer of a contract reads: the module's design, the
 * designs of the contracts it uses and of the modules its own imports
 * types from (transitively), the tagged implementations and the files of
 * the linked test declarations.
 */
export function collectMaterial(result: ImplementationPhaseResult, name: string, read: FileReader): Material {
  const { modules, index, linking, compiler } = result;
  const contract = index!.contracts.find((candidate) => candidate.name === name)!;
  const moduleOf = (moduleId: string) => modules.find((module) => module.moduleId === moduleId)!;
  const own = moduleOf(contract.module);
  const files: PacketFile[] = [];
  const include = (file: PacketFile | undefined) => {
    if (file && !files.includes(file)) files.push(file);
  };
  for (const document of own.documents) include(read(document.file, "design", document.source));

  const usesEdges = index!.edges.filter((edge): edge is Edge & { kind: "uses" } => edge.kind === "uses");
  const uses = usesEdges.filter((edge) => edge.from === name).map((edge) => ({ contract: edge.to, module: edge.toModule }));
  const usedBy = usesEdges.filter((edge) => edge.to === name).map((edge) => ({ contract: edge.from, module: edge.fromModule }));
  const reached = new Set<string>([contract.module]);
  const queue = [contract.module];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const edge of index!.edges) {
      if (edge.kind === "type-import" && edge.fromModule === next && !reached.has(edge.toModule)) {
        reached.add(edge.toModule);
        queue.push(edge.toModule);
      }
    }
  }
  for (const { module } of uses) reached.add(module);
  reached.delete(contract.module);
  const dependencyModules = [...reached].sort(compareText);
  for (const moduleId of dependencyModules) for (const document of moduleOf(moduleId).documents) include(read(document.file, "design", document.source));

  const implementations = (linking?.implementations ?? []).filter((implementation) => implementation.contract === name);
  for (const implementation of implementations) include(read(implementation.location.file, "implementation"));
  const declarations = (linking?.tests ?? []).filter((test) => test.contract === name);
  const testFiles = [...new Set(declarations.map((test) => test.location.file))].sort(compareText);
  for (const file of testFiles) include(read(file, "test"));

  // A review is about the contract, its implementations and the tests declared for it: a change elsewhere in those files is not a change of the material.
  const parts: MaterialPart[] = [{ key: "contract", text: contract.source }];
  const textOf = (file: string) => files.find((candidate) => candidate.path === file)?.text;
  for (const implementation of implementations.slice().sort((a, b) => compareText(a.location.file, b.location.file) || compareText(a.name, b.name))) {
    const text = textOf(implementation.location.file);
    const statement = compiler && text !== undefined ? statementAt(compiler.ts, text, implementation.location, false) : undefined;
    parts.push({ key: `implementation ${implementation.location.file}#${implementation.name}`, text: statement ?? text ?? "" });
  }
  const titles = new Map<string, number>();
  for (const declaration of declarations.slice().sort((a, b) => compareText(a.location.file, b.location.file) || a.location.line - b.location.line)) {
    const text = textOf(declaration.location.file);
    const statement = compiler && text !== undefined ? statementAt(compiler.ts, text, declaration.location, true) : undefined;
    const title = `${declaration.location.file}:${declaration.title}`;
    const seen = titles.get(title) ?? 0;
    titles.set(title, seen + 1);
    parts.push({ key: `test ${title}${seen > 0 ? ` (${seen + 1})` : ""}`, text: statement ?? text ?? "" });
  }
  return { contract, own, dependencyDesigns: dependencyModules.flatMap((moduleId) => moduleOf(moduleId).documents.map((document) => document.file)), uses, usedBy, implementations, declarations, testFiles, files, parts };
}

/** The text of the statement at a location: the top-level one holding it, or, for a test, the expression statement that starts there. */
function statementAt(ts: TypeScript, text: string, location: SourceLocation, nested: boolean): string | undefined {
  const sourceFile = ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest, true);
  const position = sourceFile.getPositionOfLineAndCharacter(location.line - 1, location.column - 1);
  if (!nested) return sourceFile.statements.find((statement) => statement.getStart() <= position && position < statement.end)?.getFullText().trim();
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isExpressionStatement(node) && node.getStart() === position) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found?.getFullText().trim();
}

/** A file outside the module that imports an implementation of the contract: who depends on the contract from the code's side. */
export interface ExternalUse {
  file: string;
  line: number;
  /** The implementations it imports, by name. */
  names: string[];
}

/**
 * The project files outside the module that import an implementation of the
 * contract. Only imports: not calls, not what they do with it. Files are
 * read only when their text mentions an implementation's name.
 */
export function externalUses(
  root: string,
  ts: TypeScript,
  overlay: Pick<Overlay, "resolveFrom">,
  implementations: readonly Implementation[],
  moduleId: string,
  candidates: readonly string[],
): ExternalUse[] {
  if (implementations.length === 0) return [];
  const names = new Set(implementations.map((implementation) => implementation.name));
  const implementationFiles = new Set(implementations.map((implementation) => implementation.location.file));
  const mentions = new RegExp(`\\b(${[...names].map((name) => name.replace(/[$]/g, "\\$&")).join("|")})\\b`);
  const found: ExternalUse[] = [];
  for (const file of candidates) {
    if (moduleId === "." || file.startsWith(`${moduleId}/`) || implementationFiles.has(file)) continue;
    let text: string;
    try {
      text = stripBom(fs.readFileSync(path.join(root, file), "utf8"));
    } catch {
      continue;
    }
    if (!mentions.test(text)) continue;
    const fileName = path.join(root, file);
    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const bindings = statement.importClause?.namedBindings;
      const imported = bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => (element.propertyName ?? element.name).text).filter((name) => names.has(name)) : [];
      if (imported.length === 0) continue;
      const resolved = overlay.resolveFrom(statement.moduleSpecifier.text, fileName);
      if (!resolved || !implementationFiles.has(toProjectPath(root, resolved))) continue;
      found.push({ file, line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1, names: imported.sort(compareText) });
    }
  }
  return found.sort((a, b) => compareText(a.file, b.file) || a.line - b.line);
}

export const digestOf = (text: string) => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;

/** The digest of every part of the material, by key, and of all of them together. */
export function fingerprintOf(parts: readonly MaterialPart[]): { fingerprint: string; digests: Record<string, string> } {
  const digests = parts.map((part) => [part.key, digestOf(part.text)] as const);
  const hash = crypto.createHash("sha256");
  for (const [key, digest] of digests) hash.update(`${key}\n${digest}\0`);
  return { fingerprint: `sha256:${hash.digest("hex")}`, digests: Object.fromEntries(digests) };
}

