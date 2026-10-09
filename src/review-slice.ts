import type ts from "typescript";
import type { TypeScript } from "./typescript.ts";
import { codeFingerprintText, fileDirectiveRanges } from "./review-fingerprint.ts";
import { objectMembers, readMember } from "./review-members.ts";

export interface Slice {
  text: string;
  fingerprintText: string;
  pieces: { startLine: number; endLine: number }[];
}

/** Text and locations come from the same snapshot. Positions never enter the digest. */
export function sliceNodes(ts: TypeScript, nodes: readonly ts.Node[]): Slice {
  const pieces = nodes.map((node) => {
    const source = node.getSourceFile();
    const full = node.getFullText();
    const first = node.pos + full.length - full.trimStart().length;
    return { startLine: source.getLineAndCharacterOfPosition(first).line + 1, endLine: source.getLineAndCharacterOfPosition(node.end).line + 1 };
  });
  for (const source of new Set(nodes.map((node) => node.getSourceFile()))) {
    for (const range of fileDirectiveRanges(ts, source)) {
      const startLine = source.getLineAndCharacterOfPosition(range.pos).line + 1;
      const endLine = source.getLineAndCharacterOfPosition(range.end).line + 1;
      if (!pieces.some((piece) => piece.startLine <= startLine && piece.endLine >= endLine)) pieces.push({ startLine, endLine });
    }
  }
  return {
    // Keep raw declaration text unchanged for legacy review fingerprints.
    text: nodes.map((node) => node.getFullText().trim()).join("\n\n"),
    fingerprintText: JSON.stringify(nodes.map((node) => codeFingerprintText(ts, node))),
    pieces,
  };
}

/**
 * Binding and slicing over an already bounded set of snapshots. This host cannot read the disk,
 * load libraries, or resolve an import outside those snapshots. The resolver only names targets;
 * a missing snapshot is an unavailable proof, never permission to read another file.
 */
export function dependencySlices(
  ts: TypeScript,
  sources: ReadonlyMap<string, ts.SourceFile>,
  roots: readonly { file: string; nodes: ts.Node[] }[],
  dependencies: readonly string[],
  stopAt: ReadonlySet<string>,
  resolve: (specifier: string, file: string) => string | undefined,
  members = true,
): { roots: Slice[]; dependencies: Map<string, Slice | undefined> } {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => sources.get(name),
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => sources.has(name),
    readFile: (name) => sources.get(name)?.text,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram({ rootNames: [...sources.keys()], options: { noLib: true, noResolve: true, noEmit: true, allowJs: true, types: [] }, host });
  const checker = program.getTypeChecker();
  const dependencySet = new Set(dependencies);
  const selections = new Map(dependencies.map((file) => [file, new Set<ts.Statement>()]));
  const whole = new Set<string>();
  const top = (node: ts.Node): ts.Statement | undefined => {
    while (node.parent && !ts.isSourceFile(node.parent)) node = node.parent;
    return node.parent && ts.isSourceFile(node.parent) ? node as ts.Statement : undefined;
  };
  const targets = new Map<ts.ImportDeclaration | ts.ExportDeclaration, string | undefined>();
  const target = (statement: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined => {
    if (!targets.has(statement)) {
      const specifier = statement.moduleSpecifier;
      targets.set(statement, specifier && ts.isStringLiteral(specifier) ? resolve(specifier.text, statement.getSourceFile().fileName) : undefined);
    }
    return targets.get(statement);
  };
  const typeImport = (statement: ts.ImportDeclaration): boolean => {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    return !!clause && (clause.isTypeOnly || (!clause.name && !!bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly)));
  };
  const typeExport = (statement: ts.ExportDeclaration): boolean => statement.isTypeOnly || (!!statement.exportClause && ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length > 0 && statement.exportClause.elements.every((element) => element.isTypeOnly));
  const imported = (declaration: ts.Declaration): { file: string | undefined; name: string | undefined; statement: ts.ImportDeclaration } | undefined => {
    const statement = top(declaration);
    if (!statement || !ts.isImportDeclaration(statement) || typeImport(statement)) return undefined;
    if (ts.isImportSpecifier(declaration)) return declaration.isTypeOnly ? undefined : { file: target(statement), name: (declaration.propertyName ?? declaration.name).text, statement };
    if (ts.isImportClause(declaration)) return { file: target(statement), name: "default", statement };
    if (ts.isNamespaceImport(declaration)) return { file: target(statement), name: undefined, statement };
    return undefined;
  };
  const symbols = new Map<ts.Identifier, ts.Symbol | undefined>();
  const symbolAt = (node: ts.Identifier): ts.Symbol | undefined => {
    if (!symbols.has(node)) symbols.set(node, ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node));
    return symbols.get(node);
  };
  const exported = (file: string, name: string, visiting = new Set<string>()): ts.Statement[] | undefined => {
    const key = `${file}\0${name}`;
    if (visiting.has(key)) return undefined;
    visiting.add(key);
    const source = sources.get(file);
    if (!source) return undefined;
    for (const statement of source.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals && name === "default") return [statement];
      if (ts.isExportDeclaration(statement) && !typeExport(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        const element = statement.exportClause.elements.find((candidate) => !candidate.isTypeOnly && candidate.name.text === name);
        if (!element) continue;
        if (statement.moduleSpecifier) {
          const file = target(statement);
          const declaration = file && exported(file, (element.propertyName ?? element.name).text, visiting);
          return declaration ? [statement, ...declaration] : undefined;
        }
        const symbol = checker.getExportSpecifierLocalTargetSymbol(element);
        const declarations = symbol?.declarations?.map(top).filter((node): node is ts.Statement => !!node);
        return declarations?.length ? [statement, ...declarations] : undefined;
      }
      if (!ts.canHaveModifiers(statement)) continue;
      const modifiers = ts.getModifiers(statement);
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
        if (name === "default") return [statement];
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) return [statement];
      else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name)) return [statement];
    }
    return undefined;
  };

  // Proof results include transitive initialization. A cycle or a boundary fails closed.
  const proof = new Map<string, boolean>();
  const proving = new Set<string>();
  const expressions = new Map<ts.Expression, boolean>();
  const inert = (file: string): boolean => {
    const known = proof.get(file);
    if (known !== undefined) return known;
    const source = sources.get(file);
    if (!source || proving.has(file) || stopAt.has(file) || program.getSyntacticDiagnostics(source).length > 0) return false;
    proving.add(file);
    const constants = new Set<ts.Node>();
    const expression = (node: ts.Expression): boolean => {
      const known = expressions.get(node);
      if (known !== undefined) return known;
      const safe = evaluate(node);
      expressions.set(node, safe);
      return safe;
    };
    // A shared initializer is a graph, not a tree. Cache completed expression proofs across
    // the snapshots, while the active constant/module sets still reject recursive cycles.
    const evaluate = (node: ts.Expression): boolean => {
      if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return expression(node.expression);
      if (ts.isPrefixUnaryExpression(node)) return (node.operator === ts.SyntaxKind.PlusToken || node.operator === ts.SyntaxKind.MinusToken) && ts.isNumericLiteral(node.operand);
      if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) && expression(element));
      if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && expression(property.initializer) || members && ts.isMethodDeclaration(property) && !ts.isComputedPropertyName(property.name));
      if (!ts.isIdentifier(node)) return false;
      const symbol = symbolAt(node);
      const binding = symbol?.declarations?.map(imported).find((candidate) => candidate !== undefined);
      if (binding) {
        if (!binding.file || !binding.name || !inert(binding.file)) return false;
        const declarations = exported(binding.file, binding.name);
        const last = declarations?.at(-1);
        if (!last || !ts.isVariableStatement(last) || last.declarationList.declarations.length !== 1) return false;
        const initializer = last.declarationList.declarations[0].initializer;
        return !!initializer && expression(initializer);
      }
      const declaration = symbol?.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const) || !declaration.initializer || constants.has(declaration)) return false;
      constants.add(declaration);
      const safe = expression(declaration.initializer);
      constants.delete(declaration);
      return safe;
    };
    const safe = source.statements.every((statement) => {
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isFunctionDeclaration(statement)) return true;
      if (ts.isVariableStatement(statement)) return !!(statement.declarationList.flags & ts.NodeFlags.Const) && statement.declarationList.declarations.every((declaration) => ts.isIdentifier(declaration.name) && !!declaration.initializer && expression(declaration.initializer));
      if (ts.isExportAssignment(statement)) return !statement.isExportEquals && expression(statement.expression);
      if (ts.isImportDeclaration(statement)) {
        if (typeImport(statement)) return true;
        const clause = statement.importClause;
        const file = target(statement);
        return !!clause && (!clause.namedBindings || ts.isNamedImports(clause.namedBindings)) && !!file && inert(file);
      }
      if (ts.isExportDeclaration(statement)) {
        if (typeExport(statement)) return true;
        if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) return false;
        const file = target(statement);
        return !statement.moduleSpecifier || (!!file && inert(file));
      }
      return false;
    });
    proving.delete(file);
    proof.set(file, safe);
    return safe;
  };
  const makeWhole = (file: string | undefined): void => {
    if (!file || !dependencySet.has(file) || whole.has(file)) return;
    whole.add(file);
    if (stopAt.has(file)) return;
    for (const statement of sources.get(file)!.statements) {
      if (ts.isImportDeclaration(statement) && !typeImport(statement) || ts.isExportDeclaration(statement) && !typeExport(statement)) makeWhole(target(statement));
      else if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) makeWhole(resolve(statement.moduleReference.expression.text, file));
    }
  };
  for (const file of dependencies) if (!inert(file)) makeWhole(file);

  const objects = members ? objectMembers(ts, sources, symbolAt, imported, exported) : undefined;
  const partial = new Map<ts.Statement, Set<string>>();
  const select = (statement: ts.Statement, member?: string): void => {
    const file = statement.getSourceFile().fileName;
    const selected = selections.get(file);
    if (!selected || whole.has(file) || selected.has(statement) && !partial.has(statement)) return;
    const object = member === undefined ? undefined : objects?.get(statement);
    if (object && object.properties.has(member!)) {
      const demanded = partial.get(statement) ?? new Set<string>();
      if (demanded.has(member!)) return;
      demanded.add(member!);
      partial.set(statement, demanded);
      selected.add(statement);
      const declaration = object.statement.declarationList.declarations[0];
      if (declaration.type) references(declaration.type, (node) => select(node));
      let initializer = declaration.initializer!;
      while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer) || ts.isSatisfiesExpression(initializer)) {
        if (!ts.isParenthesizedExpression(initializer)) references(initializer.type, (node) => select(node));
        initializer = initializer.expression;
      }
      references(object.properties.get(member!)!, (node) => select(node));
      return;
    }
    partial.delete(statement);
    selected.add(statement);
    references(statement, (node) => select(node));
  };
  const demand = (file: string | undefined, name: string | undefined, member?: string): void => {
    if (!file || !dependencySet.has(file)) return;
    const declarations = name && exported(file, name);
    if (!declarations) makeWhole(file);
    else for (const declaration of declarations) {
      // Keep a named re-export's connecting syntax without broadening its target back to all members.
      if (member !== undefined && objects?.get(declarations.at(-1)!) && ts.isExportDeclaration(declaration)) selections.get(declaration.getSourceFile().fileName)?.add(declaration);
      else select(declaration, member);
    }
  };
  const referenceStatements = new Map<ts.Node, ReadonlySet<ts.Statement>>();
  const references = (node: ts.Node, include: (node: ts.Statement) => void): void => {
    const known = referenceStatements.get(node);
    if (known) {
      for (const statement of known) include(statement);
      return;
    }
    const statements = new Set<ts.Statement>();
    const visit = (child: ts.Node): void => {
      if (ts.isImportDeclaration(child)) return;
      if (ts.isWithStatement(child) || (ts.isIdentifier(child) && (child.text === "eval" || child.text === "Function"))) {
        const file = node.getSourceFile().fileName;
        if (dependencySet.has(file)) makeWhole(file);
        else for (const dependency of dependencies) makeWhole(dependency);
      }
      if (ts.isExportDeclaration(child) && child.moduleSpecifier) {
        if (!typeExport(child) && child.exportClause && ts.isNamedExports(child.exportClause)) for (const element of child.exportClause.elements) if (!element.isTypeOnly) demand(target(child), (element.propertyName ?? element.name).text);
        return;
      }
      if (ts.isIdentifier(child)) {
        if (members && ts.isPropertyAccessExpression(child.parent) && child.parent.name === child) return;
        const symbol = ts.isExportSpecifier(child.parent) ? checker.getExportSpecifierLocalTargetSymbol(child.parent) : symbolAt(child);
        for (const declaration of symbol?.declarations ?? []) {
          if (members && (declaration as ts.NamedDeclaration).name === child && !ts.isShorthandPropertyAssignment(child.parent)) continue;
          // Bindings inside the selected method are already traversed with it. Their
          // top-level owner is not an additional reference to the enclosing object.
          if (members && declaration.getSourceFile() === node.getSourceFile() && declaration.pos >= node.pos && declaration.end <= node.end) continue;
          const binding = imported(declaration);
          if (binding) {
            statements.add(binding.statement);
            demand(binding.file, binding.name, members ? readMember(ts, child) : undefined);
          } else {
            const statement = top(declaration);
            if (statement && !ts.isImportDeclaration(statement) && statement.getSourceFile() === node.getSourceFile()) {
              if (members && dependencySet.has(statement.getSourceFile().fileName) && objects?.get(statement)) select(statement, readMember(ts, child));
              else statements.add(statement);
            }
          }
        }
      }
      ts.forEachChild(child, visit);
    };
    visit(node);
    // Dependency selections only grow during this call. Reusing a traversal needs to
    // replay its local connections, while its dependency demands have already applied.
    referenceStatements.set(node, statements);
    for (const statement of statements) include(statement);
  };
  // Initialization belongs to the file, not to each implementation/test selected from it.
  // Its dependency demands are monotonic within this collection; apply them once and reuse
  // the connecting imports without letting a root's own imports leak into its neighbours.
  const setupBySource = new Map<ts.SourceFile, ReadonlySet<ts.Statement>>();
  const moduleSetup = (source: ts.SourceFile | undefined): ReadonlySet<ts.Statement> => {
    if (source && setupBySource.has(source)) return setupBySource.get(source)!;
    const extra = new Set<ts.Statement>();
    const setupVisited = new Set<ts.Node>();
    const includeSetup = (statement: ts.Node): void => {
      if (setupVisited.has(statement)) return;
      setupVisited.add(statement);
      // Preserve materialAt's established test/setup text, including its distinction between
      // runner hooks and local functions with hook-like names. Module initialization additionally
      // selects its imported dependencies and their connecting statements, not arbitrary callbacks.
      if (ts.isImportDeclaration(statement)) extra.add(statement);
      if (ts.isExpressionStatement(statement) && runnerCall(statement.expression)) {
        eagerRegistration(statement.expression);
        return;
      }
      references(statement, includeSetup);
    };
    const runnerCall = (expression: ts.Expression): "suite" | "deferred" | undefined => {
      const members: string[] = [];
      let callee = expression;
      while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) {
        if (ts.isPropertyAccessExpression(callee)) members.unshift(callee.name.text);
        callee = callee.expression;
      }
      if (!ts.isIdentifier(callee)) return undefined;
      for (const declaration of symbolAt(callee)?.declarations ?? []) {
        const binding = imported(declaration);
        const specifier = binding?.statement.moduleSpecifier;
        if (!binding || !specifier || !ts.isStringLiteral(specifier) || (specifier.text !== "node:test" && specifier.text !== "vitest")) continue;
        const nodeRunner = specifier.text === "node:test";
        const hooks = nodeRunner ? ["before", "after", "beforeEach", "afterEach"] : ["beforeAll", "afterAll", "beforeEach", "afterEach"];
        const registrations = ["describe", "suite", "it", "test", ...hooks];
        const modifiers = nodeRunner ? ["skip", "only", "todo"] : ["skip", "only", "todo", "concurrent", "sequential", "fails", "shuffle", "each", "skipIf", "runIf"];
        let name = ts.isNamespaceImport(declaration) ? "*" : binding.name;
        let suffix = members;
        if (name === "*" || (nodeRunner && (name === "default" || name === "test") && members.length > 0 && registrations.includes(members[0]))) {
          name = members[0];
          suffix = members.slice(1);
        } else if (nodeRunner && name === "default") name = "test";
        if (name && registrations.includes(name) && suffix.every((member) => modifiers.includes(member))) return name === "describe" || name === "suite" ? "suite" : "deferred";
      }
      return undefined;
    };
    const passive = (node: ts.Expression): boolean => {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isLiteralExpression(node) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return passive(node.expression);
      if (ts.isArrayLiteralExpression(node)) return node.elements.every((element) => !ts.isSpreadElement(element) && !ts.isOmittedExpression(element) && passive(element));
      if (ts.isObjectLiteralExpression(node)) return node.properties.every((property) => ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && passive(property.initializer));
      return false;
    };
    const eagerRegistration = (node: ts.Node): void => {
      // Callback function values are created here, but their bodies belong to their own tests.
      // Calls used to compute titles/options or to build a registration do execute immediately.
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
      if (ts.isIdentifier(node)) {
        const callable = (declaration: ts.Node | undefined): boolean => {
          if (!declaration) return false;
          if (ts.isFunctionDeclaration(declaration)) return true;
          if (ts.isVariableStatement(declaration)) return declaration.declarationList.declarations.length === 1 && callable(declaration.declarationList.declarations[0]);
          if (ts.isVariableDeclaration(declaration)) return !!declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer));
          if (ts.isExportAssignment(declaration)) return ts.isArrowFunction(declaration.expression) || ts.isFunctionExpression(declaration.expression);
          return false;
        };
        const declarations = symbolAt(node)?.declarations ?? [];
        const callback = declarations.some((declaration) => {
          const binding = imported(declaration);
          return binding ? !!binding.file && !!binding.name && callable(exported(binding.file, binding.name)?.at(-1)) : callable(declaration);
        });
        if (!callback) includeSetup(node);
        return;
      }
      const callee = (expression: ts.Expression): void => {
        if (ts.isCallExpression(expression)) eagerRegistration(expression);
        else if (ts.isPropertyAccessExpression(expression)) callee(expression.expression);
        else if (ts.isElementAccessExpression(expression)) {
          callee(expression.expression);
          eagerRegistration(expression.argumentExpression);
        } else includeSetup(expression);
      };
      if (ts.isCallExpression(node) && runnerCall(node)) {
        callee(node.expression);
        for (const argument of node.arguments) {
          if (runnerCall(node) === "suite" && (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))) eagerRegistration(argument.body);
          else if (runnerCall(node) === "suite" && ts.isIdentifier(argument)) includeSetup(argument);
          else eagerRegistration(argument);
        }
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        // An ordinary callee may invoke a callback argument synchronously; a property read may
        // invoke a getter. Their references cannot use the runner's deferred-callback exception.
        includeSetup(node);
      } else ts.forEachChild(node, eagerRegistration);
    };
    if (source) {
      if (program.getSyntacticDiagnostics(source).length > 0) for (const file of dependencies) makeWhole(file);
      for (const statement of source.statements) {
        // Module-level setup runs before a test or implementation. Runner registrations are
        // already represented by the selected test and its effective hooks. Suite callbacks
        // execute now, while unrelated test/hook callbacks must remain outside this part.
        if (ts.isExpressionStatement(statement)) {
          if (runnerCall(statement.expression)) eagerRegistration(statement.expression);
          else includeSetup(statement);
        }
        else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => declaration.initializer && (!ts.isIdentifier(declaration.name) || !passive(declaration.initializer)))) includeSetup(statement);
        else if (ts.isClassDeclaration(statement)) {
          let initializes = !!statement.heritageClauses?.length;
          const visit = (node: ts.Node): void => {
            if (ts.isDecorator(node) || ts.isComputedPropertyName(node) || ts.isClassStaticBlockDeclaration(node) || (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))) initializes = true;
            ts.forEachChild(node, visit);
          };
          visit(statement);
          if (initializes) includeSetup(statement);
        } else if (!ts.isExpressionStatement(statement) && !ts.isVariableStatement(statement) && !ts.isImportDeclaration(statement) && !ts.isImportEqualsDeclaration(statement) && !ts.isExportDeclaration(statement) && !ts.isFunctionDeclaration(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isEmptyStatement(statement)) {
          // Blocks, branches, loops, namespaces, enums and export assignments can execute setup.
          includeSetup(statement);
        }
        // These imports do not identify a declaration to select. Preserve the old whole-file
        // dependency even when a local binding cannot be resolved by the bounded program.
        if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly && ts.isExternalModuleReference(statement.moduleReference) && ts.isStringLiteral(statement.moduleReference.expression)) {
          extra.add(statement);
          makeWhole(resolve(statement.moduleReference.expression.text, source.fileName));
        } else if (ts.isImportDeclaration(statement) && !statement.importClause) {
          extra.add(statement);
          makeWhole(target(statement));
        } else if (ts.isImportDeclaration(statement) && !typeImport(statement)) {
          const file = target(statement);
          // Retargeting/reordering even an unused binding can reorder observable initialization.
          if (!file || !inert(file)) extra.add(statement);
        } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !typeExport(statement)) {
          const file = target(statement);
          if (!file || !inert(file)) extra.add(statement);
        }
      }
    }
    if (source) setupBySource.set(source, extra);
    return extra;
  };
  const rootSlices = roots.map(({ nodes }) => {
    const extra = new Set(moduleSetup(nodes[0]?.getSourceFile()));
    for (const node of nodes) references(node, (statement) => {
      // Existing materialAt owns the local declaration/setup selection. Only connecting imports
      // are added here; walking a containing suite would accidentally include its unrelated tests.
      if (ts.isImportDeclaration(statement)) extra.add(statement);
    });
    return sliceNodes(ts, [...nodes, ...[...extra].filter((node) => !nodes.includes(node)).sort((a, b) => a.pos - b.pos)]);
  });
  // A whole dependency can import a root implementation/test file. Its material is already present;
  // preserve that boundary rather than pulling another contract's implementation into this one.
  return { roots: rootSlices, dependencies: new Map(dependencies.map((file) => {
    if (whole.has(file)) return [file, undefined];
    const selected = [...selections.get(file)!].sort((a, b) => a.pos - b.pos);
    const slice = sliceNodes(ts, selected);
    if (selected.some((node) => partial.has(node))) slice.fingerprintText = JSON.stringify(selected.map((node) => {
      const demanded = partial.get(node);
      const object = demanded && objects?.get(node);
      return object ? [object.shell, ...[...demanded!].sort().map((name) => [name, codeFingerprintText(ts, object.properties.get(name)!)])] : codeFingerprintText(ts, node);
    }));
    return [file, slice];
  })) };
}
