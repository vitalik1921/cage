import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { Contract, Edge, Implementation, SourceLocation, TestDeclaration } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import { compareText, type Diagnostic } from "./diagnostic.ts";
import type { ImplementationPhaseResult } from "./implementation-phase.ts";
import { insideRoot, stripBom, toProjectPath } from "./location.ts";
import type { Overlay, TypeScript } from "./typescript.ts";

/** A file the reviewer reads, once, whatever number of contracts it serves. Its text has `\n` line endings whatever the disk has. */
export interface PacketFile {
  path: string;
  /**
   * "helper": a project file a test file imports, loaded because a reviewer has to see what a stub stands in for.
   * "dependency": a fingerprinted local file, loaded whole because it changed since the recorded review.
   */
  role: "design" | "implementation" | "test" | "helper" | "dependency";
  text: string;
  /** Of the normalized text, so that the line endings of a checkout do not count as a change. */
  digest: string;
}

/**
 * One piece of what a review of a contract is about. `contract`: its declaration with its doc comment.
 * `design <file>`: the prose of a document of its module, its `ts design` blocks left out. `implementation
 * <file>#<name>` and `test <file>:<title>`: the statement, with the declarations of the same file it refers
 * to and, for a test, the setup of its suites. `dependency <file>`: a local file that an implementation or
 * test file imports, within the bounds of the review scope.
 */
export interface MaterialPart {
  key: string;
  text: string;
  /** The file the part comes from, project-relative; every part but `contract`'s declaration text has one. */
  file: string;
  /** Where the part starts in its file: the declaration's line, for an implementation or a test. */
  line?: number;
  /** The name of an implementation or the title of a test. */
  name?: string;
  /** The invariants a test part covers. */
  covers?: string[];
  /** The line ranges of the file the part's text was taken from, in the order of the text; absent when the part is a whole file or document. */
  pieces?: { startLine: number; endLine: number }[];
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
  /** What the fingerprint is made of; see `MaterialPart`. */
  parts: MaterialPart[];
  /** The local files fingerprinted as dependencies, project-relative, in the order they were reached. */
  dependencies: string[];
  /** Local files that the bounds of the review scope left out of the fingerprint: a change in them does not make the review outdated. */
  beyond: { file: string; why: Beyond }[];
  /** Dependency files that could not be read. */
  unreadable: { file: string; message: string }[];
}

export type FileReader = (file: string, role: PacketFile["role"], text?: string) => PacketFile | undefined;

/** Why a local file is left out of a fingerprint: past the depth, past the file limit, or a link out of the project. */
export type Beyond = "depth" | "maxFiles" | "outside";

/**
 * A reader that loads each file once and reports what cannot be read. A file among `sources` (the texts the
 * check read, see `linking.sources`) is taken from there and not from the disk: the locations of implementations,
 * tests and hooks are positions in that text, and a file edited during the run would no longer match them.
 */
export function createFileReader(root: string, diagnostics: Diagnostic[], sources?: ReadonlyMap<string, string>): { read: FileReader; files: Map<string, PacketFile> } {
  const files = new Map<string, PacketFile>();
  const outside = new Set<string>();
  const read: FileReader = (file, role, text) => {
    const known = files.get(file);
    if (known) return known;
    // A link out of the project is not followed: what lies outside is not the project's to hand to a reviewer.
    if (text === undefined && !insideRoot(root, file)) {
      if (!outside.has(file)) {
        outside.add(file);
        diagnostics.push({ code: "W_OUTSIDE_ROOT", severity: "warning", message: `${file} is a symbolic link to a file outside the project: cage does not read it into the review or its fingerprint. A change there does not make a review outdated.`, file });
      }
      return undefined;
    }
    try {
      const normalized = (sources?.get(file) ?? text ?? stripBom(fs.readFileSync(path.join(root, file), "utf8"))).replace(/\r\n?/g, "\n");
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

  // A review is about the contract, the rules its module states in prose, its implementations, the tests declared for it,
  // and the local code they rely on. A change elsewhere in those files is not a change of the material.
  const parts: MaterialPart[] = [{ key: "contract", text: contract.source, file: contract.location.file, line: contract.location.line, name: contract.name }];
  for (const document of own.documents) parts.push({ key: `design ${document.file}`, text: proseOf(document.source, document.blocks), file: document.file });
  const textOf = (file: string) => files.find((candidate) => candidate.path === file)?.text;
  const parsed = new Map<string, ts.SourceFile>();
  const parse = (file: string, text: string) => {
    if (!compiler) return undefined;
    if (!parsed.has(file)) parsed.set(file, compiler.ts.createSourceFile(file, text, compiler.ts.ScriptTarget.Latest, true));
    return parsed.get(file)!;
  };
  for (const implementation of implementations.slice().sort((a, b) => compareText(a.location.file, b.location.file) || compareText(a.name, b.name))) {
    const text = textOf(implementation.location.file);
    const sourceFile = text !== undefined ? parse(implementation.location.file, text) : undefined;
    const material = compiler && sourceFile ? materialAt(compiler.ts, sourceFile, implementation.location, false) : undefined;
    parts.push({ key: `implementation ${implementation.location.file}#${implementation.name}`, text: material?.text ?? text ?? "", file: implementation.location.file, line: implementation.location.line, name: implementation.name, ...(material ? { pieces: material.pieces } : {}) });
  }
  const titles = new Map<string, number>();
  for (const declaration of declarations.slice().sort((a, b) => compareText(a.location.file, b.location.file) || a.location.line - b.location.line)) {
    const text = textOf(declaration.location.file);
    const sourceFile = text !== undefined ? parse(declaration.location.file, text) : undefined;
    const material = compiler && sourceFile ? materialAt(compiler.ts, sourceFile, declaration.location, true, declaration.setup) : undefined;
    const title = `${declaration.location.file}:${declaration.title}`;
    const seen = titles.get(title) ?? 0;
    titles.set(title, seen + 1);
    parts.push({ key: `test ${title}${seen > 0 ? ` (${seen + 1})` : ""}`, text: material?.text ?? text ?? "", file: declaration.location.file, line: declaration.location.line, name: declaration.title, covers: declaration.covers, ...(material ? { pieces: material.pieces } : {}) });
  }

  // The local files the implementations and the tests import, within the bounds of the review scope.
  const ownFiles = new Set([...implementations.map((implementation) => implementation.location.file), ...testFiles]);
  const otherImplementations = new Set((linking?.implementations ?? []).map((implementation) => implementation.location.file).filter((file) => !ownFiles.has(file)));
  const closure = compiler
    ? dependencyClosure(result.root, compiler.ts, compiler.overlay, [...ownFiles].sort(compareText).map((file) => ({ file, text: textOf(file) ?? "" })), ownFiles, otherImplementations, result.reviewScope)
    : { files: [], beyond: [], unreadable: [] };
  for (const dependency of closure.files) parts.push({ key: `dependency ${dependency.file}`, text: dependency.text, file: dependency.file });
  return {
    contract,
    own,
    dependencyDesigns: dependencyModules.flatMap((moduleId) => moduleOf(moduleId).documents.map((document) => document.file)),
    uses,
    usedBy,
    implementations,
    declarations,
    testFiles,
    files,
    parts,
    dependencies: closure.files.map((dependency) => dependency.file),
    beyond: closure.beyond,
    unreadable: closure.unreadable,
  };
}

/**
 * The prose of a design document: its text with each `ts design` block replaced by a marker. The
 * declarations are parts of their own; the prose is the business context a reviewer judges against,
 * and a change in it is a change of what every contract of the module promises.
 */
function proseOf(source: string, blocks: readonly { sourceStart: number; sourceEnd: number; order: number }[]): string {
  let prose = "";
  let at = 0;
  for (const block of [...blocks].sort((a, b) => a.sourceStart - b.sourceStart)) {
    prose += `${source.slice(at, block.sourceStart)}[ts design block ${block.order + 1}]`;
    at = block.sourceEnd;
  }
  return (prose + source.slice(at)).replace(/\r\n?/g, "\n");
}

/** The names a top-level statement declares, for a lookup of what a statement refers to. Imports declare none: their files are dependencies. */
function declaredNames(ts: TypeScript, statement: ts.Statement): string[] {
  const names: string[] = [];
  const bind = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) names.push(statement.name.text);
  else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) names.push(statement.name.text);
  else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) bind(declaration.name);
  return names;
}

/** Every identifier written in a node. Over-inclusive on purpose: a property name that matches a declaration only adds that declaration. */
function identifiersIn(ts: TypeScript, node: ts.Node, into: Set<string>): Set<string> {
  const walk = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) into.add(child.text);
    ts.forEachChild(child, walk);
  };
  walk(node);
  return into;
}

/** The expression statement that starts at a location: a test declaration or a hook, wherever it is nested. */
function expressionStatementAt(ts: TypeScript, sourceFile: ts.SourceFile, location: SourceLocation): ts.ExpressionStatement | undefined {
  const position = sourceFile.getPositionOfLineAndCharacter(location.line - 1, location.column - 1);
  let found: ts.ExpressionStatement | undefined;
  const visit = (node: ts.Node) => {
    if (found || position < node.pos || position >= node.end) return;
    if (ts.isExpressionStatement(node) && node.getStart() === position) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The text a review of an implementation or a test is about: its statement — the top-level one holding the
 * implementation, or the expression statement of the test — then, for a test, its setup: the runner hooks
 * in effect for it (`setup`, found by their binding to the runner when the declarations were read: the
 * file's top-level ones and those of its suites, aliased, namespaced or global alike) and the variables,
 * functions and classes its enclosing suites declare; then the top-level declarations of the same file
 * that any of these refer to, followed transitively, in source order. `pieces` are the line ranges the text
 * was taken from, in the same order, so that a reader can be shown exactly those lines of the file.
 */
function materialAt(ts: TypeScript, sourceFile: ts.SourceFile, location: SourceLocation, nested: boolean, hooks: readonly SourceLocation[] = []): { text: string; pieces: { startLine: number; endLine: number }[] } | undefined {
  const position = sourceFile.getPositionOfLineAndCharacter(location.line - 1, location.column - 1);
  const start: ts.Node | undefined = nested ? expressionStatementAt(ts, sourceFile, location) : sourceFile.statements.find((statement) => statement.getStart() <= position && position < statement.end);
  if (!start) return undefined;

  const setup: ts.Node[] = [];
  if (nested) {
    for (const hook of hooks) {
      const statement = expressionStatementAt(ts, sourceFile, hook);
      if (statement && !setup.includes(statement)) setup.push(statement);
    }
    // The lexical surroundings of the test: what its suites' callbacks, the plain blocks and the loop bodies around
    // it declare, and the headers of those loops. Declarations and headers only, read as text: what a test observes
    // through them is the reviewer's to judge, and an edit to them is a change of the test.
    for (let node: ts.Node | undefined = start.parent; node && node !== sourceFile; node = node.parent) {
      if (ts.isForOfStatement(node) || ts.isForInStatement(node)) setup.push(node.initializer, node.expression);
      else if (ts.isForStatement(node)) setup.push(...[node.initializer, node.condition, node.incrementor].filter((part): part is ts.ForInitializer | ts.Expression => part !== undefined));
      if (!ts.isBlock(node)) continue;
      const suite = (ts.isArrowFunction(node.parent) || ts.isFunctionExpression(node.parent)) && ts.isCallExpression(node.parent.parent);
      if (!suite && ts.isFunctionLike(node.parent)) continue;
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement) || ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) setup.push(statement);
      }
    }
  }

  const declarations = new Map<string, ts.Statement[]>();
  for (const statement of sourceFile.statements) for (const name of declaredNames(ts, statement)) declarations.set(name, [...(declarations.get(name) ?? []), statement]);
  const own = sourceFile.statements.find((statement) => statement.getStart() <= start!.getStart() && start!.end <= statement.end);
  const included = new Set<ts.Statement>(own ? [own] : []);
  const referenced: ts.Statement[] = [];
  const queue: ts.Node[] = [start, ...setup];
  for (let node = queue.shift(); node; node = queue.shift()) {
    for (const name of identifiersIn(ts, node, new Set())) {
      for (const statement of declarations.get(name) ?? []) {
        if (included.has(statement)) continue;
        included.add(statement);
        referenced.push(statement);
        queue.push(statement);
      }
    }
  }
  const text = (node: ts.Node) => node.getFullText().trim();
  const nodes = [start, ...setup.sort((a, b) => a.pos - b.pos), ...referenced.sort((a, b) => a.pos - b.pos)];
  // The lines the trimmed full text spans: from its first non-blank character (a comment before the node is part of it) to the node's end.
  const range = (node: ts.Node) => {
    const full = node.getFullText();
    const first = node.pos + (full.length - full.trimStart().length);
    return { startLine: sourceFile.getLineAndCharacterOfPosition(first).line + 1, endLine: sourceFile.getLineAndCharacterOfPosition(node.end).line + 1 };
  };
  return { text: nodes.map(text).join("\n\n"), pieces: nodes.map(range) };
}

/** The local files a file imports for their values: type-only imports and exports, and dynamic `import()` and `require()` calls, are not followed. */
function valueImports(ts: TypeScript, sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      const typesOnly = clause !== undefined && (clause.isTypeOnly || (!clause.name && bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)));
      if (!typesOnly) specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && !statement.isTypeOnly) {
      specifiers.push(statement.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression) && !statement.isTypeOnly) {
      specifiers.push(statement.moduleReference.expression.text);
    }
  }
  return specifiers;
}

/**
 * The local files reached from `starts` through value imports, breadth first, in a fixed order: each
 * level sorted by path. Not followed and not fingerprinted: files outside the root, in `node_modules`,
 * declaration files, files matching `scope.exclude`, and unresolved specifiers. Files of `own` are
 * material already. A file of another contract's implementation is fingerprinted but not followed: what
 * it imports is that contract's material. Files past `scope.depth` levels, past `scope.maxFiles`, or
 * whose real path leaves the project through a symbolic link (checked before anything is read) are
 * returned as `beyond`, so that the hole is reported rather than silent.
 */
export function dependencyClosure(
  root: string,
  ts: TypeScript,
  overlay: Pick<Overlay, "resolveFrom">,
  starts: readonly { file: string; text: string }[],
  own: ReadonlySet<string>,
  stopAt: ReadonlySet<string>,
  scope: { depth: number; maxFiles: number; exclude: readonly string[] },
): { files: { file: string; text: string }[]; beyond: { file: string; why: Beyond }[]; unreadable: { file: string; message: string }[] } {
  const files: { file: string; text: string }[] = [];
  const beyond: { file: string; why: Beyond }[] = [];
  const unreadable: { file: string; message: string }[] = [];
  const seen = new Set<string>(own);
  const local = (resolved: string): string | undefined => {
    const file = toProjectPath(root, resolved);
    if (file.startsWith("../") || path.isAbsolute(file) || file.split("/").includes("node_modules") || /\.d\.[cm]?ts$/.test(file)) return undefined;
    if (scope.exclude.some((pattern) => path.matchesGlob(file, pattern))) return undefined;
    return file;
  };
  const importsOf = (file: string, text: string) => {
    const fileName = path.join(root, file);
    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
    const found = new Set<string>();
    for (const specifier of valueImports(ts, sourceFile)) {
      const resolved = overlay.resolveFrom(specifier, fileName);
      const reached = resolved && local(resolved);
      if (reached) found.add(reached);
    }
    return [...found].sort(compareText);
  };
  let level = starts.map(({ file, text }) => ({ file, text }));
  for (let depth = 1; level.length > 0; depth++) {
    const next: { file: string; text: string }[] = [];
    for (const { file, text } of level) {
      for (const imported of importsOf(file, text)) {
        if (seen.has(imported)) continue;
        seen.add(imported);
        if (depth > scope.depth) {
          beyond.push({ file: imported, why: "depth" });
          continue;
        }
        if (files.length >= scope.maxFiles) {
          beyond.push({ file: imported, why: "maxFiles" });
          continue;
        }
        // Checked before reading: a link out of the project is a hole in the fingerprint, said and not followed.
        if (!insideRoot(root, imported)) {
          beyond.push({ file: imported, why: "outside" });
          continue;
        }
        let content: string;
        try {
          content = stripBom(fs.readFileSync(path.join(root, imported), "utf8")).replace(/\r\n?/g, "\n");
        } catch (cause) {
          // The system's message names the file by its full path; the report names it from the project.
          unreadable.push({ file: imported, message: (cause as Error).message.replaceAll(path.join(root, imported), imported) });
          continue;
        }
        files.push({ file: imported, text: content });
        if (!stopAt.has(imported)) next.push({ file: imported, text: content });
      }
    }
    // Past the depth only the next level is looked at, to name what the bound leaves out.
    level = depth > scope.depth ? [] : next;
  }
  return { files, beyond, unreadable };
}

/** A file outside the module that imports an implementation of the contract: who depends on the contract from the code's side. */
export interface ExternalUse {
  file: string;
  line: number;
  /** The implementations it imports, by name. */
  names: string[];
  /** The contract's members the file calls on them, as far as the syntax shows: `this.accounts.findById(…)` on a property or parameter declared with the implementation's type. */
  members: string[];
}

/** The members, among `members`, that the file calls on something declared with one of the `names` as its type. */
function membersCalled(ts: TypeScript, sourceFile: ts.SourceFile, names: ReadonlySet<string>, members: ReadonlySet<string>): string[] {
  const holders = new Set<string>();
  const declared = (node: ts.Node): void => {
    if ((ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) && node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && names.has(node.type.typeName.text) && ts.isIdentifier(node.name)) {
      holders.add(node.name.text);
    }
    ts.forEachChild(node, declared);
  };
  declared(sourceFile);
  const called = new Set<string>();
  const calls = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && members.has(node.name.text)) {
      const target = node.expression;
      const holder = ts.isPropertyAccessExpression(target) ? target.name.text : ts.isIdentifier(target) ? target.text : undefined;
      if (holder !== undefined && holders.has(holder)) called.add(node.name.text);
    }
    ts.forEachChild(node, calls);
  };
  calls(sourceFile);
  return [...called].sort(compareText);
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
  members: readonly string[],
  candidates: readonly string[],
): ExternalUse[] {
  if (implementations.length === 0) return [];
  const names = new Set(implementations.map((implementation) => implementation.name));
  const memberNames = new Set(members);
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
      found.push({ file, line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1, names: imported.sort(compareText), members: membersCalled(ts, sourceFile, names, memberNames) });
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

