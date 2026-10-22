import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { TypeScript } from "./typescript.ts";

export interface PackageSelection {
  /** Declarations whose types participate in the imported binding, keyed by the program's file name. */
  declarations: Map<string, ts.Node[]>;
  /** Declaration files found through selected symbols and compiler references. */
  dependencies: string[];
  /** Project files reached only through global contributions and their helpers, never a package module route. */
  globalDependencies: Set<string>;
  /** Resolution edges written into review and lock material, by the source file that contains each edge. */
  routing: Map<string, string[]>;
  /** Missing bindings are rejected only when the compiler reports an error at their use. */
  unresolved: { file: ts.SourceFile; start: number; end: number; message: string }[];
}

/** A compiler lib is a boundary only when the compiler says it is a default lib and it belongs to its real lib directory. */
export function isCompilerLibrary(program: ts.Program, sourceFile: ts.SourceFile, defaultLibDirectory: string): boolean {
  const real = (fileName: string) => { try { return fs.realpathSync.native(fileName); } catch { return path.resolve(fileName); } };
  const relative = path.relative(real(defaultLibDirectory), real(sourceFile.fileName));
  return program.isSourceFileDefaultLibrary(sourceFile) && relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Follow the symbols that an imported name denotes, rather than every statement in a declaration file. Routing files
 * remain part of the material; the selected nodes are the compiler diagnostic boundary. All declarations of a merged
 * symbol are visited, including declarations contributed by other installed packages.
 */
export function selectPackageDependencies(
  ts: TypeScript,
  checker: ts.TypeChecker,
  program: ts.Program,
  entry: ts.SourceFile,
  names: readonly string[],
  resolveModule: (specifier: string, fromFile: string, mode: ts.ResolutionMode) => string | undefined,
  resolveTypes: (name: string, fromFile: string, mode: ts.ResolutionMode) => string | undefined,
  followSourceValues = false,
  isProjectFile: (fileName: string) => boolean = () => false,
): PackageSelection {
  const declarations = new Map<string, ts.Node[]>();
  const dependencies = new Set<string>([entry.fileName]);
  const globalDependencies = new Set<string>();
  const moduleDependencies = new Set<string>([entry.fileName]);
  const routing = new Map<string, string[]>();
  const unresolved: PackageSelection["unresolved"] = [];
  const missing = (anchor: ts.Node, message: string) => unresolved.push({ file: anchor.getSourceFile(), start: anchor.getStart(), end: anchor.getEnd(), message });
  // A symbol may be reached both through an ambient contribution and a direct package import. Neither path may
  // hide the other; direct module provenance wins even if the global path was visited first.
  const visited = [new Set<ts.Symbol>(), new Set<ts.Symbol>()];
  const selected = [new Set<ts.Node>(), new Set<ts.Node>()];
  const defaultLibDirectory = path.dirname(ts.getDefaultLibFilePath(program.getCompilerOptions()));
  const libraryCache = new Map<string, boolean>();
  const isLibrary = (file: ts.SourceFile) => {
    const known = libraryCache.get(file.fileName);
    if (known !== undefined) return known;
    const value = isCompilerLibrary(program, file, defaultLibDirectory);
    libraryCache.set(file.fileName, value);
    return value;
  };
  const addDependency = (fileName: string, fromGlobal = false) => {
    dependencies.add(fileName);
    (fromGlobal && isProjectFile(fileName) ? globalDependencies : moduleDependencies).add(fileName);
  };
  const isGlobal = (node: ts.Node): boolean => {
    for (let parent: ts.Node | undefined = node; parent && !ts.isSourceFile(parent); parent = parent.parent) {
      if (ts.isModuleDeclaration(parent)) {
        if (parent.flags & ts.NodeFlags.GlobalAugmentation) return true;
        // An ambient external module is not a global contribution.
        if (ts.isStringLiteral(parent.name)) return false;
      }
    }
    return !ts.isExternalModule(node.getSourceFile());
  };

  const addRoute = (fileName: string, route: string) => {
    const routes = routing.get(fileName) ?? [];
    if (!routes.includes(route)) routes.push(route);
    routing.set(fileName, routes);
  };
  const moduleTarget = (literal: ts.StringLiteralLike): { target: string | undefined; bound: string[]; mode: ts.ResolutionMode } => {
    const file = literal.getSourceFile();
    const mode = ts.getModeForUsageLocation(file, literal, program.getCompilerOptions());
    const resolved = resolveModule(literal.text, file.fileName, mode);
    // A runtime package may have no own .d.ts while the checker binds its import to an ambient declaration.
    // Its bound symbol is the type dependency; the JavaScript resolution is irrelevant to type provenance.
    const symbol = checker.getSymbolAtLocation(literal) ?? checker.getAmbientModules().find((candidate) => candidate.name === JSON.stringify(literal.text));
    const bound = [...new Set((symbol?.declarations ?? []).map((candidate) => candidate.getSourceFile()).filter((candidate) => candidate.isDeclarationFile && !isLibrary(candidate)).map((candidate) => candidate.fileName))];
    const target = resolved && program.getSourceFile(resolved)?.isDeclarationFile ? resolved : bound[0] ?? resolved;
    return { target, bound, mode };
  };
  const missingImport = (binding: ts.Node): void => {
    for (let node: ts.Node | undefined = binding; node && !ts.isSourceFile(node); node = node.parent) {
      const literal = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined;
      if (literal && ts.isStringLiteral(literal)) {
        if (!moduleTarget(literal).target) missing(literal, `"${literal.text}" resolves to nothing`);
        return;
      }
    }
  };
  const select = (node: ts.Node, fromGlobal = false): void => {
    if (ts.isBindingElement(node)) {
      // A destructured export's type annotation belongs to the enclosing variable declaration. Binding patterns can
      // nest through object and array elements, so reach the variable rather than assuming a fixed parent depth.
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (ts.isVariableDeclaration(parent)) { select(parent, fromGlobal); return; }
        if (ts.isSourceFile(parent)) break;
      }
    }
    const file = node.getSourceFile();
    fromGlobal = isProjectFile(file.fileName) && (fromGlobal || isGlobal(node));
    // A built-in declaration can refer to an augmentation in an installed package. Traverse it without materializing
    // the compiler's own file or checking its diagnostics.
    if (isLibrary(file)) { visit(node); return; }
    addDependency(file.fileName, fromGlobal);
    const seen = selected[Number(fromGlobal)];
    if (seen.has(node)) return;
    seen.add(node);
    const nodes = declarations.get(file.fileName) ?? [];
    if (!nodes.includes(node)) nodes.push(node);
    declarations.set(file.fileName, nodes);
    // The module literal is outside an import specifier's range. Its compiler error still belongs to that binding.
    if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node) || ts.isImportEqualsDeclaration(node)) {
      missingImport(node);
      for (let parent: ts.Node | undefined = node.parent; parent && parent !== file; parent = parent.parent) {
        if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
          if (!nodes.includes(parent)) nodes.push(parent);
          break;
        }
      }
    }
    visit(node, fromGlobal);
  };
  const valueExports = (moduleSymbol: ts.Symbol, seen = new Set<ts.Symbol>()): ts.Symbol[] => {
    const location = moduleSymbol.valueDeclaration ?? moduleSymbol.declarations?.[0];
    if (!location || seen.has(moduleSymbol)) return [];
    seen.add(moduleSymbol);
    const properties = checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(moduleSymbol, location));
    const statements = (moduleSymbol.declarations ?? []).flatMap((declaration) =>
      ts.isSourceFile(declaration) ? [...declaration.statements] :
        ts.isModuleDeclaration(declaration) && declaration.body && ts.isModuleBlock(declaration.body) ? [...declaration.body.statements] : []);
    const stars = statements.filter((statement): statement is ts.ExportDeclaration =>
      ts.isExportDeclaration(statement) && !statement.exportClause && !!statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier));
    // The checker knows local value exports, including `export import`, destructured variables and ambient implicit
    // exports. Only star routes need refinement: TS 5.9 exposes classes from `export type *` as value properties.
    if (!stars.length) return properties;
    const owners = new Set<ts.Node>(moduleSymbol.declarations ?? []);
    const declaredHere = (declaration: ts.Declaration) => {
      for (let parent: ts.Node | undefined = declaration.parent; parent; parent = parent.parent) {
        if (ts.isModuleDeclaration(parent) || ts.isSourceFile(parent)) return owners.has(parent);
      }
      return false;
    };
    const allowed = new Set(properties.filter((property) => property.declarations?.some(declaredHere)).map((property) => property.name));
    for (const star of stars) {
      if (star.isTypeOnly || !star.moduleSpecifier || !ts.isStringLiteral(star.moduleSpecifier)) continue;
      const target = checker.getSymbolAtLocation(star.moduleSpecifier);
      if (target) for (const exported of valueExports(target, new Set(seen))) allowed.add(exported.name);
    }
    return properties.filter((property) => allowed.has(property.name));
  };
  const follow = (symbol: ts.Symbol | undefined, anchor?: ts.Node, fromGlobal = false): void => {
    if (!symbol) {
      if (anchor) missing(anchor, `${anchor.getText()} names nothing the compiler finds`);
      return;
    }
    // The checker can reuse one unresolved symbol for several names. Keep every use so its own compiler
    // diagnostic (including a suppression on that use) decides whether it is an unresolved dependency.
    if (!symbol.declarations?.length && anchor && symbol.name !== "globalThis") {
      missing(anchor, `${anchor.getText()} names nothing the compiler finds`);
    }
    const seen = visited[Number(fromGlobal)];
    if (seen.has(symbol)) return;
    seen.add(symbol);
    const module = !!(symbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.NamespaceModule));
    for (const declaration of symbol.declarations ?? []) {
      if (module && (ts.isSourceFile(declaration) || ts.isModuleDeclaration(declaration))) {
        // `typeof import("dep")` denotes the module's value exports. Selecting its SourceFile or whole ambient module
        // would make unrelated type-only exports diagnostic roots.
        const file = declaration.getSourceFile();
        if (!isLibrary(file)) addDependency(file.fileName, isProjectFile(file.fileName) && (fromGlobal || isGlobal(declaration)));
      } else select(declaration, fromGlobal);
    }
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const target = checker.getAliasedSymbol(symbol);
      const globalAlias = (symbol.declarations ?? []).some((declaration) =>
        isProjectFile(declaration.getSourceFile().fileName) && (fromGlobal || isGlobal(declaration)));
      if (target !== symbol) follow(target, anchor, globalAlias);
    }
    if (module) {
      // Even the compiler's module value type can expose a class routed through `export type *` on TS 5.9.
      // Follow only names with a value-capable export route through each module in the chain.
      for (const property of valueExports(symbol)) follow(property, undefined, fromGlobal);
      for (const declaration of symbol.declarations ?? []) {
        const body = ts.isSourceFile(declaration) ? declaration.statements : ts.isModuleDeclaration(declaration) && declaration.body && ts.isModuleBlock(declaration.body) ? declaration.body.statements : [];
        for (const statement of body) if (ts.isExportAssignment(statement)) follow(checker.getSymbolAtLocation(statement.expression), statement.expression, fromGlobal && isProjectFile(statement.getSourceFile().fileName));
      }
    }
  };
  const followName = (name: ts.Node, fromGlobal = false) => {
    const member = ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name;
    follow(checker.getSymbolAtLocation(member), member, fromGlobal);
    let root = name;
    while (ts.isQualifiedName(root) || ts.isPropertyAccessExpression(root)) root = ts.isQualifiedName(root) ? root.left : root.expression;
    // A missing namespace import reports at its module literal, not at Namespace.Member. Probe that binding
    // without following all namespace exports, which would select unrelated declarations from valid imports.
    if (root !== member) for (const binding of checker.getSymbolAtLocation(root)?.declarations ?? []) missingImport(binding);
  };
  const visit = (node: ts.Node, fromGlobal = false): void => {
    // Inferred source types (typeof schema, factory results) depend on value initializers and their helpers too.
    if ((followSourceValues || fromGlobal) && !node.getSourceFile().isDeclarationFile && ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) follow(symbol, undefined, fromGlobal);
    }
    if (ts.isTypeReferenceNode(node)) followName(node.typeName, fromGlobal);
    else if (ts.isExpressionWithTypeArguments(node)) {
      const expression = node.expression;
      followName(expression, fromGlobal);
    } else if (ts.isTypeQueryNode(node)) {
      const name = node.exprName;
      followName(name, fromGlobal);
      // `typeof globalThis` includes package globals, even when a property is reached through an indexed type.
      if (ts.isIdentifier(name) && name.text === "globalThis") {
        const global = checker.getTypeAtLocation(name);
        for (const property of checker.getPropertiesOfType(global)) follow(property, undefined, fromGlobal);
      }
    } else if (ts.isComputedPropertyName(node)) followName(node.expression, fromGlobal);
    else if (ts.isPropertyAccessExpression(node)) followName(node, fromGlobal);
    else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        const literal = node.argument.literal;
        const { target, bound, mode } = moduleTarget(literal);
        if (target) {
          addDependency(target, fromGlobal);
          for (const fileName of bound) addDependency(fileName, fromGlobal);
          addRoute(literal.getSourceFile().fileName, JSON.stringify(["ImportType", literal.text, String(mode), target]));
        } else missing(literal, `"${literal.text}" resolves to nothing`);
        if (node.isTypeOf && !node.qualifier) follow(checker.getSymbolAtLocation(literal), literal, fromGlobal);
      }
      if (node.qualifier) followName(ts.isQualifiedName(node.qualifier) ? node.qualifier.right : node.qualifier, fromGlobal);
    } else if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
      followName(node.propertyName ?? node.name, fromGlobal);
    } else if (ts.isImportClause(node) && node.name) followName(node.name, fromGlobal);
    else if (ts.isNamespaceImport(node) || ts.isNamespaceExport(node)) followName(node.name, fromGlobal);
    else if (ts.isExportAssignment(node)) followName(node.expression, fromGlobal);
    ts.forEachChild(node, (child) => visit(child, fromGlobal));
  };

  const moduleSymbol = checker.getSymbolAtLocation(entry);
  if (moduleSymbol) {
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const name of names) {
      const exported = exports.find((symbol) => symbol.name === name);
      if (exported) follow(exported);
      else unresolved.push({ file: entry, start: 0, end: entry.end, message: `${name} is not exported by ${entry.fileName}` });
    }
  }
  // The compiler skips re-export routing declarations when it gives an export its final symbol. Keep those files and
  // edges in material, and retain the intermediate files where a selected import binding passes through a package.
  for (const fileName of dependencies) {
    const file = program.getSourceFile(fileName);
    if (!file || isLibrary(file)) continue;
    for (const statement of file.statements) {
      const literal = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier
        : ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference) && statement.moduleReference.expression && ts.isStringLiteral(statement.moduleReference.expression)
          ? statement.moduleReference.expression
          : undefined;
      if (!literal) continue;
      const { target, bound, mode } = moduleTarget(literal);
      if (target) {
        const selected = declarations.get(fileName) ?? [];
        if (!selected.includes(statement) && !dependencies.has(target)) continue;
        addRoute(file.fileName, JSON.stringify([ts.SyntaxKind[statement.kind], literal.text, String(mode), target]));
        const fromGlobal = isProjectFile(fileName) && globalDependencies.has(fileName);
        for (const fileName of bound) addDependency(fileName, fromGlobal);
        const loaded = program.getSourceFile(target);
        if (loaded && !isLibrary(loaded)) addDependency(loaded.fileName, fromGlobal);
      }
    }
  }
  // A root declaration file remains in the material even if no names of a namespace import are used.
  for (const fileName of dependencies) {
    const file = program.getSourceFile(fileName);
    if (!file || isLibrary(file)) continue;
    const fromGlobal = isProjectFile(fileName) && globalDependencies.has(fileName);
    for (const reference of file.referencedFiles) {
      const base = path.resolve(path.dirname(fileName), reference.fileName);
      const target = [base, `${base}.d.ts`, `${base}.ts`].map((candidate) => program.getSourceFile(candidate)).find((candidate) => candidate !== undefined);
      if (target && !isLibrary(target)) addDependency(target.fileName, fromGlobal);
      else if (!target) unresolved.push({ file, start: reference.pos, end: reference.end, message: `/// <reference path="${reference.fileName}" /> resolves to nothing` });
    }
    for (const reference of file.typeReferenceDirectives) {
      const resolved = resolveTypes(reference.fileName, fileName, ts.getModeForFileReference(reference, file.impliedNodeFormat));
      const target = resolved && program.getSourceFile(resolved);
      if (target && !isLibrary(target)) addDependency(target.fileName, fromGlobal);
      else if (!target) unresolved.push({ file, start: reference.pos, end: reference.end, message: `/// <reference types="${reference.fileName}" /> resolves to nothing` });
    }
  }
  for (const routes of routing.values()) routes.sort();
  for (const fileName of moduleDependencies) globalDependencies.delete(fileName);
  return { declarations, dependencies: [...dependencies], globalDependencies, routing, unresolved };
}
