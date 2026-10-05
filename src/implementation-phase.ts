import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { Contract, Implementation, Invariant, SourceLocation, TestDeclaration } from "./design-model.ts";
import { checkDesignPhase, createConverter, environmentDiagnostics, type Converter, type DesignPhaseOptions, type DesignPhaseResult, type Origin } from "./design-phase.ts";
import { IGNORE_FILE, ownerOf, readModuleScopes, type ModuleScope } from "./coverage.ts";
import { compareDiagnostics, hasErrors, type Diagnostic } from "./diagnostic.ts";
import type { SourceFiles } from "./discovery.ts";
import { readImplementations, type FoundImplementation } from "./implementations.ts";
import { stripBom, toProjectPath } from "./location.ts";
import { BINDING_TAGS } from "./metadata.ts";
import { readTestDeclarations, type RejectedLink, type TestAdapter } from "./test-declarations.ts";
import { createOverlayProgram, readStrictOptions, requireSourceFile, syntaxOnlyOptions, type Overlay, type TypeScript } from "./typescript.ts";

export interface ImplementationPhaseOptions extends DesignPhaseOptions {
  /** Implementation and test files of the scope, relative to `root`. */
  sources: SourceFiles;
  /** The test runner whose declarations are read. */
  testAdapter: TestAdapter;
  /** Exported code of a designed module without `@implements`: not looked at, a warning, or an error. Default: a warning. */
  coverage?: "off" | "warn" | "require";
  /** The bounds of the dependency part of review fingerprints; `exclude` already holds the configuration's `exclude` too. */
  reviewScope?: ReviewScope;
}

/** How far review fingerprints follow local imports; see `ReviewDependencies` in the configuration. */
export interface ReviewScope {
  depth: number;
  maxFiles: number;
  exclude: string[];
}

export const DEFAULT_REVIEW_SCOPE: ReviewScope = { depth: 3, maxFiles: 40, exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"] };

/** The test declarations that link an invariant: inside a `@tests` suite of its contract, with its id in `@covers`. */
export function testsLinkedTo(tests: readonly TestDeclaration[], contract: string, invariant: string): TestDeclaration[] {
  return tests.filter((test) => test.contract === contract && test.covers.includes(invariant));
}

export interface ImplementationPhaseResult extends DesignPhaseResult {
  /** The project root, absolute, and the bounds review fingerprints are taken with. */
  root: string;
  reviewScope: ReviewScope;
  /** Whether the design phase ended without errors: only then are implementations and tests looked at. */
  designSound: boolean;
  /**
   * Implementations and test declarations. Null when they were not read,
   * which is not "none found": the design phase had errors, or the compiler
   * setup turned out unusable once the project's files were part of it.
   */
  linking: {
    implementations: Implementation[];
    tests: TestDeclaration[];
    /** Invariants not checked for a test because a rejected tag names their contract: fixing the tag may reveal them. */
    uncheckedInvariants: number;
    /**
     * The implementation and test files as this phase read them, by project path. Every location above is a
     * position in these texts; a later read of the disk may find a file changed in between.
     */
    sources: ReadonlyMap<string, string>;
  } | null;
}

/** A source file the phase reads closely, as it is on the disk. */
interface TaggedFile {
  /** Project-relative path. */
  file: string;
  fileName: string;
  text: string;
  /** Whether the text mentions a binding tag. */
  tagged: boolean;
  /** The module whose design should cover the file; undefined outside every module, or when the module ignores it. */
  owner: ModuleScope | undefined;
}

/**
 * Implementation phase: everything of the design phase, then whether the
 * generated files are current, whether each contract has tagged
 * implementations that the compiler accepts in its place, and whether each
 * invariant has a test declaration tagged with it. Test code is read, never
 * run: a linked declaration says that a test exists, not that it passes.
 */
export function checkImplementationPhase(options: ImplementationPhaseOptions): ImplementationPhaseResult {
  const root = path.resolve(options.root);
  const design = checkDesignPhase(options);
  const { modules, index, compiler, diagnostics } = design;
  const reviewScope = options.reviewScope ?? DEFAULT_REVIEW_SCOPE;
  if (hasErrors(diagnostics) || !index || !compiler) return { ...design, root, reviewScope, designSound: false, linking: null };
  const { ts, overlay } = compiler;
  const tsconfig = toProjectPath(root, path.resolve(root, options.tsconfig));

  const weak = Object.entries(readStrictOptions(ts, compiler.options)).filter(([, on]) => !on).map(([name]) => name);
  if (weak.length > 0) {
    diagnostics.push({
      code: "W_WEAK_TYPECHECK",
      severity: "warning",
      message: `${weak.join(", ")} off`,
      file: tsconfig,
    });
  }

  const unreadable = (what: string, file: string, cause: unknown): Diagnostic => ({
    code: "E_ENVIRONMENT",
    severity: "error",
    message: `cannot read the ${what}: ${(cause as Error).message}`,
    file,
  });
  const coverage = options.coverage ?? "warn";
  const { scopes, diagnostics: ignoreProblems } = readModuleScopes(root, modules.map((module) => module.moduleId));
  diagnostics.push(...ignoreProblems);

  // Files that mention a binding tag are read closely, and so are the files of a module with a design, which is
  // expected to cover them. The rest of the project is not the harness's to lint.
  const mentionsTag = new RegExp(`@(${[...BINDING_TAGS].join("|")})(?![A-Za-z0-9-])`);
  const read = (files: readonly string[], expectDesign: boolean): TaggedFile[] =>
    files.flatMap((file) => {
      const fileName = path.join(root, file);
      const module = expectDesign && coverage !== "off" ? ownerOf(scopes, file) : undefined;
      const owner = module && !module.ignores(file) ? module : undefined;
      try {
        const text = stripBom(fs.readFileSync(fileName, "utf8"));
        const tagged = mentionsTag.test(text);
        return tagged || owner ? [{ file, fileName, text, tagged, owner }] : [];
      } catch (cause) {
        diagnostics.push(unreadable("source file", file, cause));
        return [];
      }
    });
  const testFiles = read(options.sources.tests, false);

  const contracts = new Map(index.contracts.map((contract) => [contract.name, contract]));
  const { found, implementationFiles, attempted } = findImplementations(ts, root, read(options.sources.implementations, true), contracts, coverage === "require" ? "require" : "warn", diagnostics);

  // One in-memory file per implementation asks the compiler whether it fits its contract.
  const checks = found.map((implementation, order) => {
    const contract = contracts.get(implementation.contract)!;
    const implementationFile = path.join(root, implementation.location.file);
    const fileName = `${implementationFile.slice(0, -".ts".length)}.cage-check-${order + 1}.ts`;
    const designFile = modules.find((module) => module.moduleId === contract.module)!.virtualFile;
    const subject = implementation.kind === "class" ? `implementation.${implementation.name}` : `typeof implementation.${implementation.name}`;
    const text = [
      `import type * as implementation from ${JSON.stringify(specifierFor(overlay, fileName, implementationFile))};`,
      `import type * as design from ${JSON.stringify(specifierFor(overlay, fileName, designFile))};`,
      `declare const value: ${subject};`,
      `value satisfies design.${contract.name};`,
      "",
    ].join("\n");
    return { implementation, contract, fileName, text };
  });
  // The compiler gets the very text that was just read, not a second read of the disk.
  const sources = [...implementationFiles, ...testFiles];
  overlay.add(new Map([...sources.map(({ fileName, text }): [string, string] => [fileName, text]), ...checks.map((check): [string, string] => [check.fileName, check.text])]));

  // The project's own files are part of the program for the sake of its global declarations.
  const roots = [...compiler.fileNames, ...modules.map((module) => module.virtualFile), ...sources.map(({ fileName }) => fileName), ...checks.map((check) => check.fileName)];
  const program = overlay.createProgram([...new Set(roots)]);
  const origins = new Map(modules.map((module): [ts.SourceFile, Origin] => [requireSourceFile(program, module.virtualFile), { module, extracted: module.generated }]));
  const convert = createConverter(ts, root, program, origins);

  // The design phase checked the compiler setup with the designs alone; with the project's files as roots
  // there can be more, such as a file the tsconfig lists and the disk does not have.
  const setupProblems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  if (setupProblems.length > 0) {
    diagnostics.push(...environmentDiagnostics(convert, tsconfig, setupProblems));
    diagnostics.sort(compareDiagnostics);
    return { ...design, root, reviewScope, designSound: true, linking: null };
  }

  // A file the harness makes a claim about must itself be sound: a type error in it makes its types unreliable.
  for (const { fileName } of implementationFiles) {
    const sourceFile = requireSourceFile(program, fileName);
    diagnostics.push(...[...program.getSyntacticDiagnostics(sourceFile), ...program.getSemanticDiagnostics(sourceFile)].map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
  }

  const checker = program.getTypeChecker();
  const implementations = checks.map(({ implementation, contract, fileName }): Implementation => {
    const sourceFile = requireSourceFile(program, fileName);
    const [, , declaration, question] = sourceFile.statements;
    // `value` must have the type of the implementation and be compared with the contract: if either name did not
    // resolve, the comparison would be with `any` and would pass whatever the implementation is.
    const names = [declaration, question].map((statement) => lastIdentifier(ts, statement));
    if (names.some((name) => !name || !checker.getSymbolAtLocation(name))) {
      throw new Error(`Cannot compare ${implementation.name} in ${implementation.location.file} with contract ${contract.name}: the comparison did not resolve.`);
    }
    const mismatches = program.getSemanticDiagnostics(sourceFile).filter((diagnostic) => diagnostic.start !== undefined && diagnostic.start >= question.getStart(sourceFile));
    const checkFile = toProjectPath(root, fileName);
    for (const mismatch of mismatches) {
      const converted = convert("E_TYPE_MISMATCH", mismatch);
      // The in-memory file is not something the author can open: leave out what points into it.
      const explained = (converted.related ?? []).filter((related) => related.file !== checkFile);
      diagnostics.push({
        code: "E_TYPE_MISMATCH",
        severity: "error",
        message: `${implementation.name} does not fit ${contract.name}\n${converted.message}`,
        ...implementation.location,
        tsCode: mismatch.code,
        contract: contract.name,
        related: [{ message: "contract", ...contract.location }, ...explained],
      });
    }
    const { name, kind, location } = implementation;
    return { contract: contract.name, name, kind, compatible: mismatches.length === 0, location };
  });

  const { tests, rejected } = readTests(ts, program, overlay, root, convert, options.testAdapter, testFiles, contracts, index.invariants, diagnostics);

  for (const contract of contracts.values()) {
    // A rejected `@implements`, or one in a file that could not be read, is already reported; "no implementation" would be its consequence.
    if (attempted.has(contract.name) || implementations.some((implementation) => implementation.contract === contract.name)) continue;
    diagnostics.push({
      code: "E_IMPLEMENTATION_MISSING",
      severity: "error",
      message: `${contract.name}`,
      ...contract.location,
      contract: contract.name,
    });
  }
  let uncheckedInvariants = 0;
  // Links to tests that cannot run an assertion, as their text shows. Structural, not semantic: an active test may
  // still assert nothing, and a runner may skip a test at run time; only running the tests shows that.
  // Per inactive declaration, the invariants it is linked to that do have an active test: only those are warned
  // about at the test; an invariant with no active test at all is an error at the invariant instead.
  const warned = new Map<string, { test: TestDeclaration; invariants: string[] }>();
  const keyOf = (test: TestDeclaration) => `${test.location.file}:${test.location.line}:${test.location.column}`;
  const describeTest = (test: TestDeclaration) => `"${[...test.suitePath, test.title].join(" > ")}" ${test.inactiveBecause} (${test.location.file}:${test.location.line})`;
  for (const invariant of index.invariants) {
    const linked = testsLinkedTo(tests, invariant.contract, invariant.id);
    const inactive = linked.filter((test) => test.status !== "active");
    if (linked.length > 0 && inactive.length === linked.length) {
      diagnostics.push({
        code: "E_TEST_INACTIVE",
        severity: "error",
        message: `${invariant.contract}.${invariant.id}\n${inactive.map((test) => `- ${describeTest(test)}`).join("\n")}`,
        ...invariant.location,
        contract: invariant.contract,
        invariant: invariant.id,
      });
    } else {
      for (const test of inactive) {
        const entry = warned.get(keyOf(test)) ?? { test, invariants: [] };
        entry.invariants.push(invariant.id);
        warned.set(keyOf(test), entry);
      }
    }
    if (linked.length > 0) continue;
    // Likewise for a link that was written but rejected; the summary says how many invariants wait on such a tag.
    const about = (link: RejectedLink) => link.contract === null || link.contract === invariant.contract;
    if (rejected.some((link) => about(link) && (link.invariants === "all" || link.invariants.includes(invariant.id)))) {
      uncheckedInvariants += 1;
      continue;
    }
    diagnostics.push({
      code: "E_TEST_MISSING",
      severity: "error",
      message: `${invariant.contract}.${invariant.id}`,
      ...invariant.location,
      contract: invariant.contract,
      invariant: invariant.id,
    });
  }

  for (const { test, invariants } of warned.values()) {
    diagnostics.push({
      code: "W_TEST_INACTIVE",
      severity: "warning",
      message: `"${[...test.suitePath, test.title].join(" > ")}" ${test.inactiveBecause}; covers ${invariants.map((id) => `${test.contract}.${id}`).join(", ")}`,
      ...test.location,
      contract: test.contract,
    });
  }

  diagnostics.sort(compareDiagnostics);
  return { ...design, root, reviewScope, designSound: true, linking: { implementations, tests, uncheckedInvariants, sources: new Map(sources.map(({ file, text }) => [file, text])) } };
}

const unknownContract = (tag: string, name: string, location: SourceLocation): Diagnostic => ({
  code: "E_REFERENCE_UNKNOWN",
  severity: "error",
  message: `\`@${tag} ${name}\`: no such contract`,
  ...location,
});

/** Script files a relative import may name: what else it names (JSON, styles, assets) is the runner's or a bundler's to load. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * What is broken in a test file's imports, as the compiler sees them without running anything: a relative import of a
 * script that resolves to no file, or a value import of a name that the project file it resolves to does not
 * export, or exports only as a type. Type-only imports (`import type`, `{ type X }`) are erased and do not count;
 * packages, files outside the project, declaration files, files that are not scripts (JSON, styles) and CommonJS
 * `export =` modules are the runner's to resolve. Undefined when every import is in order.
 *
 * A value import of a name that has no value at run time — an interface, a type alias, a class exported with
 * `export type`, followed through aliases and re-exports — stays in the file wherever imports are kept as written:
 * Node's own type stripping, which runs node:test files, and `verbatimModuleSyntax`. Vitest's transform drops an
 * import used only as a type, so there it is broken only under `verbatimModuleSyntax` or when the name is used as
 * a value.
 */
function brokenImport(ts: TypeScript, program: ts.Program, checker: ts.TypeChecker, overlay: Pick<Overlay, "resolveFrom">, root: string, sourceFile: ts.SourceFile, file: string, adapter: TestAdapter): string | undefined {
  const keptAsWritten = adapter === "node:test" || program.getCompilerOptions().verbatimModuleSyntax === true;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier.text;
    const at = `${file}:${sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1}`;
    const resolved = overlay.resolveFrom(specifier, sourceFile.fileName);
    if (!resolved) {
      if (/^\.\.?\//.test(specifier) && (SCRIPT_FILE.test(specifier) || path.posix.extname(specifier) === "")) return `"${specifier}" (${at}) resolves to no file`;
      continue;
    }
    const target = program.getSourceFile(resolved);
    const projectPath = toProjectPath(root, resolved);
    if (!target || target.isDeclarationFile || !SCRIPT_FILE.test(resolved) || projectPath.startsWith("../") || path.isAbsolute(projectPath) || projectPath.split("/").includes("node_modules")) continue;
    if (target.statements.some((candidate) => ts.isExportAssignment(candidate) && candidate.isExportEquals)) continue;
    const clause = statement.importClause;
    const wanted: { name: string; local: ts.Identifier }[] = clause?.name ? [{ name: "default", local: clause.name }] : [];
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) wanted.push({ name: (element.propertyName ?? element.name).text, local: element.name });
    }
    if (wanted.length === 0) continue;
    // A file without imports or exports is no module: it exports nothing.
    const module = checker.getSymbolAtLocation(statement.moduleSpecifier);
    const exports = new Map((module ? checker.getExportsOfModule(module) : []).map((symbol) => [symbol.name, symbol]));
    const missing = wanted.filter(({ name }) => !exports.has(name)).map(({ name }) => name);
    if (missing.length > 0) return `"${specifier}" (${at}) does not export ${missing.map((name) => `"${name}"`).join(", ")}`;
    const typesOnly = wanted.filter(({ name, local }) => !exportsValue(ts, checker, module!, name) && (keptAsWritten || usedAsValue(ts, checker, sourceFile, local)));
    if (typesOnly.length > 0) return `"${specifier}" (${at}) exports ${typesOnly.map(({ name }) => `"${name}"`).join(", ")} only as a type; import ${typesOnly.length === 1 ? "it" : "them"} with \`import type\``;
  }
  return undefined;
}

/**
 * Whether a module provides `name` at run time, followed the way the module's own statements pass it on:
 * a local declaration must be a value; `export { x } from`, `import { x }` and their defaults lead to the other
 * module's export of that name; `export * from` provides what its module provides as a value, and `export type *`
 * (with or without `as`) provides nothing at run time. Any `type`-only step on the way makes it a type. What the
 * compiler cannot follow, or a cycle, is not ours to call broken.
 */
function exportsValue(ts: TypeScript, checker: ts.TypeChecker, module: ts.Symbol, name: string, seen = new Set<string>()): boolean {
  const moduleFile = [module.valueDeclaration, ...(module.declarations ?? [])].find((declaration): declaration is ts.SourceFile => declaration !== undefined && ts.isSourceFile(declaration));
  const key = `${moduleFile?.fileName ?? module.name}\n${name}`;
  if (seen.has(key)) return true;
  seen.add(key);
  const exported = checker.getExportsOfModule(module).find((symbol) => symbol.name === name);
  if (!exported) return false;
  if (!moduleFile) return aliasValue(ts, checker, exported, seen);
  // Declared or passed on by name in this file: that declaration decides.
  if ((exported.declarations ?? []).some((declaration) => declaration.getSourceFile() === moduleFile)) return aliasValue(ts, checker, exported, seen, moduleFile);
  // Reached through a star: a value only if a star that is not `type`-only leads to a value of that name.
  for (const statement of moduleFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.exportClause || !statement.moduleSpecifier || statement.isTypeOnly) continue;
    const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (target && exportsValue(ts, checker, target, name, seen)) return true;
  }
  return false;
}

/** Whether a symbol a module exports is a value at run time: a local declaration by its flags, an alias by where it leads. */
function aliasValue(ts: TypeScript, checker: ts.TypeChecker, symbol: ts.Symbol, seen: Set<string>, inFile?: ts.SourceFile): boolean {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return (symbol.flags & ts.SymbolFlags.Value) !== 0;
  const moduleOf = (specifier: ts.Expression | undefined) => (specifier ? checker.getSymbolAtLocation(specifier) : undefined);
  const nameOf = (specifier: ts.ExportSpecifier | ts.ImportSpecifier) => (specifier.propertyName ?? specifier.name).text;
  for (const declaration of (symbol.declarations ?? []).filter((candidate) => inFile === undefined || candidate.getSourceFile() === inFile)) {
    if (ts.isExportSpecifier(declaration)) {
      const exportDeclaration = declaration.parent.parent;
      if (declaration.isTypeOnly || exportDeclaration.isTypeOnly) return false;
      const from = moduleOf(exportDeclaration.moduleSpecifier);
      if (from) return exportsValue(ts, checker, from, nameOf(declaration), seen);
      // `export { x }` of a local name or of an import: that name decides.
      const local = checker.getExportSpecifierLocalTargetSymbol(declaration);
      return local === undefined || aliasValue(ts, checker, local, seen);
    }
    if (ts.isImportSpecifier(declaration)) {
      if (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly) return false;
      const from = moduleOf(declaration.parent.parent.parent.moduleSpecifier);
      return from === undefined || exportsValue(ts, checker, from, nameOf(declaration), seen);
    }
    if (ts.isImportClause(declaration)) {
      if (declaration.isTypeOnly) return false;
      const from = moduleOf(declaration.parent.moduleSpecifier);
      return from === undefined || exportsValue(ts, checker, from, "default", seen);
    }
    // A namespace is an object at run time, unless it is brought in or passed on as a type.
    if (ts.isNamespaceImport(declaration)) return !declaration.parent.isTypeOnly;
    if (ts.isNamespaceExport(declaration)) return !declaration.parent.isTypeOnly;
    if (ts.isImportEqualsDeclaration(declaration) && declaration.isTypeOnly) return false;
  }
  const next = checker.getImmediateAliasedSymbol(symbol);
  return next === undefined || aliasValue(ts, checker, next, seen);
}

/** Whether a name a file imports is used anywhere in it as a value, not only in types. */
function usedAsValue(ts: TypeScript, checker: ts.TypeChecker, sourceFile: ts.SourceFile, local: ts.Identifier): boolean {
  // For a type used as a value the compiler may resolve the name to the import, to what the import aliases, or to
  // nothing: each of these is the import. A name declared nearer (a parameter, a local const) resolves to its own symbol.
  const target = checker.getSymbolAtLocation(local);
  const binding = new Set<ts.Symbol | undefined>([undefined]);
  for (let symbol = target; symbol && !binding.has(symbol); symbol = symbol.flags & ts.SymbolFlags.Alias ? checker.getImmediateAliasedSymbol(symbol) : undefined) binding.add(symbol);
  let found = false;
  const inType = (node: ts.Node) => {
    for (let current: ts.Node | undefined = node.parent; current && !ts.isStatement(current); current = current.parent) {
      if (ts.isTypeNode(current) || (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent) && current.parent.token === ts.SyntaxKind.ImplementsKeyword)) return true;
    }
    return false;
  };
  // A property's or a member's name, or a label, is not a reference to a binding, whatever it resolves to.
  const isMemberName = (node: ts.Identifier) => {
    const parent = node.parent;
    return (
      ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isMethodDeclaration(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent) || ts.isEnumMember(parent)) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.propertyName === node) ||
      ((ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && parent.label === node)
    );
  };
  const visit = (node: ts.Node): void => {
    if (found || ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node) && node.text === local.text && !inType(node) && !isMemberName(node) && binding.has(checker.getSymbolAtLocation(node))) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The names that follow a tag anywhere in a text: what a file that cannot be parsed was, by the look of it, trying to link. */
function namesAfterTag(text: string, tag: string): string[] {
  return [...text.matchAll(new RegExp(`@${tag}[ \\t]+([\\p{ID_Start}_$][\\p{ID_Continue}$]*)`, "gu"))].map((match) => match[1]);
}

/**
 * Reads `@implements` from the tagged files. A file with syntax errors is
 * reported and not read: its tree is not what the author wrote.
 */
function findImplementations(
  ts: TypeScript,
  root: string,
  files: readonly TaggedFile[],
  contracts: ReadonlyMap<string, Contract>,
  coverage: "warn" | "require",
  diagnostics: Diagnostic[],
) {
  const found: FoundImplementation[] = [];
  /** Files with an `@implements` on a declaration: the ones the harness makes a claim about. */
  const implementationFiles: TaggedFile[] = [];
  /** Contracts named by an `@implements` that was rejected or is in a file that could not be read. */
  const attempted = new Set<string>();

  const { program } = createOverlayProgram(ts, syntaxOnlyOptions, new Map(files.map(({ fileName, text }) => [fileName, text])));
  const convert = createConverter(ts, root, program, new Map());
  for (const tagged of files) {
    const sourceFile = requireSourceFile(program, tagged.fileName);
    const syntax = program.getSyntacticDiagnostics(sourceFile);
    if (syntax.length > 0) {
      // A broken file without tags is the project's own business.
      if (!tagged.tagged) continue;
      diagnostics.push(...syntax.map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
      for (const name of namesAfterTag(tagged.text, "implements")) attempted.add(name);
      continue;
    }
    const read = readImplementations(ts, sourceFile, tagged.file, tagged.tagged);
    diagnostics.push(...read.diagnostics);
    if (tagged.owner) {
      const { moduleId } = tagged.owner;
      for (const declaration of read.exported) {
        if (declaration.claimed) continue;
        diagnostics.push({
          code: coverage === "require" ? "E_NOT_DESIGNED" : "W_NOT_DESIGNED",
          severity: coverage === "require" ? "error" : "warning",
          message: `${declaration.kind} ${declaration.name} in ${moduleId}`,
          ...declaration.location,
        });
      }
    }
    for (const name of read.rejected) attempted.add(name);
    if (read.found.length > 0) implementationFiles.push(tagged);
    for (const implementation of read.found) {
      if (contracts.has(implementation.contract)) found.push(implementation);
      else diagnostics.push(unknownContract("implements", implementation.contract, implementation.tagLocation));
    }
  }
  return { found, implementationFiles, attempted };
}

/** The last identifier of the type a check statement names: `X` of `implementation.X`, `C` of `design.C`. */
function lastIdentifier(ts: TypeScript, statement: ts.Statement): ts.Identifier | undefined {
  let last: ts.Identifier | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) last = node;
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return last;
}

/** A relative specifier, as written in `fromFile`, that the project's module resolution takes to `target`. */
function specifierFor(overlay: Overlay, fromFile: string, target: string): string {
  const relative = path.relative(path.dirname(fromFile), target).split(path.sep).join("/");
  // A path into a dot-directory starts with a dot too, so test for the parent prefix, not for a dot.
  const base = (relative.startsWith("../") ? relative : `./${relative}`).replace(/\.ts$/, "");
  const specifier = [`${base}.js`, `${base}.ts`, base].find((candidate) => {
    const resolved = overlay.resolveFrom(candidate, fromFile);
    return resolved !== undefined && overlay.sameFile(resolved, target);
  });
  if (specifier === undefined) throw new Error(`Cannot import ${target} from ${fromFile} under the project's module resolution.`);
  return specifier;
}

function readTests(
  ts: TypeScript,
  program: ts.Program,
  overlay: Pick<Overlay, "resolveFrom">,
  root: string,
  convert: Converter,
  adapter: TestAdapter,
  files: readonly TaggedFile[],
  contracts: ReadonlyMap<string, Contract>,
  invariants: readonly Invariant[],
  diagnostics: Diagnostic[],
): { tests: TestDeclaration[]; rejected: RejectedLink[] } {
  const checker = program.getTypeChecker();
  const tests: TestDeclaration[] = [];
  const rejected: RejectedLink[] = [];
  for (const { file, fileName, text } of files) {
    const sourceFile = requireSourceFile(program, fileName);
    // With syntax errors the tree is not what the author wrote; report them instead of guessing declarations.
    const syntax = program.getSyntacticDiagnostics(sourceFile);
    if (syntax.length > 0) {
      diagnostics.push(...syntax.map((diagnostic) => convert("E_TYPESCRIPT", diagnostic)));
      for (const contract of namesAfterTag(text, "tests")) rejected.push({ contract, invariants: "all" });
      continue;
    }
    const read = readTestDeclarations(ts, checker, sourceFile, file, adapter);
    diagnostics.push(...read.diagnostics);
    // A file with a broken import cannot be relied on to run any of its tests, whatever each one's own text says.
    const broken = read.tests.length > 0 ? brokenImport(ts, program, checker, overlay, root, sourceFile, file, adapter) : undefined;
    rejected.push(...read.rejected);
    // An unknown contract is reported once, at its `@tests`; what the tests under it cover is then not looked at.
    for (const context of read.contexts) for (const name of context.contracts) if (!contracts.has(name)) diagnostics.push(unknownContract("tests", name, context.location));
    for (const test of read.tests) {
      const named = test.context.contracts;
      if (named.some((name) => !contracts.has(name))) continue;
      // Each id goes to the one contract among the named that has it; a test is then a declaration of every contract it covers something of.
      const covers = new Map<string, string[]>(named.map((name) => [name, []]));
      const quoted = (names: readonly string[]) => names.map((name) => `"${name}"`).join(" and ");
      for (const { id, location } of test.covers) {
        const owners = named.filter((name) => invariants.some((invariant) => invariant.contract === name && invariant.id === id));
        if (owners.length === 1) {
          covers.get(owners[0])!.push(id);
        } else if (owners.length > 1) {
          // Reported here; "has no test" for the invariant in either contract would be the consequence.
          for (const owner of owners) rejected.push({ contract: owner, invariants: [id] });
          diagnostics.push({
            code: "E_REFERENCE_AMBIGUOUS",
            severity: "error",
            message: `\`@covers ${id}\`: ${quoted(owners)} both have it`,
            ...location,
            contract: owners[0],
          });
        } else {
          // The id may be another contract's: then the test wants that contract named too.
          const elsewhere = invariants.find((invariant) => invariant.id === id && contracts.has(invariant.contract));
          const hint = elsewhere ? ` "${elsewhere.contract}" has one: name it in the tag too (\`@tests ${[...named, elsewhere.contract].join(" ")}\`), or give the test its own \`@tests ${elsewhere.contract}\` line.` : "";
          diagnostics.push({
            code: "E_REFERENCE_UNKNOWN",
            severity: "error",
            message: `\`@covers ${id}\`: ${quoted(named)} ${named.length === 1 ? "has" : "have"} no such invariant`,
            ...location,
            contract: named[0],
          });
        }
      }
      // A test that covers nothing of a named contract is still its declaration when it is the only one named: it is counted, and reviewed, there.
      for (const [name, ids] of covers) {
        if (ids.length === 0 && named.length > 1) continue;
        const state = broken ? { status: "broken-import" as const, inactiveBecause: `its file has a broken import: ${broken}` } : { status: test.status, ...(test.inactiveBecause ? { inactiveBecause: test.inactiveBecause } : {}) };
        tests.push({ title: test.title, suitePath: test.suitePath, adapter, contract: name, covers: ids, ...state, setup: test.setup, location: test.location });
      }
    }
  }
  return { tests, rejected };
}
