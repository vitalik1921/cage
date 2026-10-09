import type ts from "typescript";
import type { TypeScript } from "./typescript.ts";
import { codeFingerprintText } from "./review-fingerprint.ts";

/** A direct, static read. Writes, escapes and reflection keep the declaration whole. */
export function readMember(ts: TypeScript, node: ts.Identifier): string | undefined {
  const access = node.parent;
  let name: string;
  if (ts.isPropertyAccessExpression(access) && access.expression === node) name = access.name.text;
  else if (ts.isElementAccessExpression(access) && access.expression === node && ts.isStringLiteral(access.argumentExpression)) name = access.argumentExpression.text;
  else return undefined;
  let target: ts.Node = access;
  // Include nested paths and destructuring targets, not just `object.field = value`.
  while (target.parent) {
    const parent = target.parent;
    const path = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === target;
    // A second access may reach mutable state, including properties stored on a
    // function. The first member alone is not a proof of independence in that case.
    if (path) return undefined;
    const wrapped = ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent);
    const pattern = ts.isPropertyAssignment(parent) || ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent);
    if (!wrapped && !pattern) break;
    target = parent;
  }
  const parent = target.parent;
  if (!parent) return name;
  if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === target) return undefined;
  if (ts.isDeleteExpression(parent) || ts.isPostfixUnaryExpression(parent)) return undefined;
  if (ts.isPrefixUnaryExpression(parent) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)) return undefined;
  if (ts.isBinaryExpression(parent) && parent.left === target && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return undefined;
  return name;
}

type ObjectInfo = { statement: ts.VariableStatement; object: ts.ObjectLiteralExpression; properties: Map<string, ts.ObjectLiteralElementLike>; shell: string };

/** Bounded-source escape analysis, shared by all property demands in one collection. */
export function objectMembers(
  ts: TypeScript,
  sources: ReadonlyMap<string, ts.SourceFile>,
  symbolAt: (node: ts.Identifier) => ts.Symbol | undefined,
  imported: (node: ts.Declaration) => { file: string | undefined; name: string | undefined } | undefined,
  exported: (file: string, name: string) => ts.Statement[] | undefined,
) {
  const objects = new Map<ts.Statement, ObjectInfo>();
  const names = new Set<string>();
  const unsafe = new Set<ts.Statement>();
  let scanned = false;
  const unwrap = (expression: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression) || ts.isParenthesizedExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    return expression;
  };
  const primitive = (declaration: ts.Declaration | undefined, seen = new Set<ts.Declaration>()): boolean => {
    if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return false;
    seen.add(declaration);
    const init = unwrap(declaration.initializer);
    return ts.isStringLiteral(init) || ts.isNumericLiteral(init) || ts.isBigIntLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(init.kind) || ts.isIdentifier(init) && primitive(symbolAt(init)?.valueDeclaration, seen);
  };
  // Method independence requires more than a receiver without object-valued fields:
  // sibling methods can communicate through a closure or a helper's captured state.
  // Stay inside the snapshots, following direct helper calls; unknown captures fail closed.
  const capturesState = (node: ts.Node, receiver: ts.VariableDeclaration, seen: Set<ts.Node>): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    const visit = (child: ts.Node): true | undefined => {
      if (ts.isTypeNode(child)) return;
      if (child.kind === ts.SyntaxKind.ThisKeyword || child.kind === ts.SyntaxKind.SuperKeyword) return true;
      if (ts.isIdentifier(child)) {
        if ((child.parent as ts.NamedDeclaration).name === child && !ts.isShorthandPropertyAssignment(child.parent)) return;
        if (ts.isBindingElement(child.parent) && child.parent.propertyName === child) return;
        const symbol = symbolAt(child);
        let declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
        if (!declaration) return true;
        if (declaration !== node && declaration.getSourceFile() === node.getSourceFile() && declaration.pos >= node.pos && declaration.end <= node.end) return;
        const binding = imported(declaration);
        if (binding) {
          const statement = binding.file && binding.name ? exported(binding.file, binding.name)?.at(-1) : undefined;
          declaration = statement && ts.isFunctionDeclaration(statement) ? statement
            : statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1 ? statement.declarationList.declarations[0] : undefined;
        }
        if (declaration === receiver) return readMember(ts, child) === undefined ? true : undefined;
        if (primitive(declaration)) return;
        const helper = declaration && (ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration)) && declaration.body ? declaration
          : declaration && ts.isVariableDeclaration(declaration) && declaration.initializer ? unwrap(declaration.initializer) : undefined;
        if (!helper || !(ts.isFunctionDeclaration(helper) || ts.isArrowFunction(helper) || ts.isFunctionExpression(helper))) return true;
        // A function value can carry mutable properties or escape. Only a direct call
        // lets us use its body as the proof, including recursive helper cycles.
        let callee: ts.Node = child;
        while (ts.isParenthesizedExpression(callee.parent) || ts.isAsExpression(callee.parent) || ts.isTypeAssertionExpression(callee.parent) || ts.isNonNullExpression(callee.parent)) callee = callee.parent;
        if (!ts.isCallExpression(callee.parent) || callee.parent.expression !== callee) return true;
        return capturesState(helper, receiver, seen) ? true : undefined;
      }
      return ts.forEachChild(child, visit);
    };
    return visit(node) === true;
  };
  for (const source of sources.values()) for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const) || statement.declarationList.declarations.length !== 1) continue;
    const declaration = statement.declarationList.declarations[0];
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    let object = declaration.initializer;
    while (ts.isAsExpression(object) || ts.isSatisfiesExpression(object) || ts.isParenthesizedExpression(object) || ts.isTypeAssertionExpression(object)) object = object.expression;
    if (!ts.isObjectLiteralExpression(object)) continue;
    const properties = new Map<string, ts.ObjectLiteralElementLike>();
    const checkedCaptures = new Set<ts.Node>();
    let safe = true;
    for (const property of object.properties) {
      if (!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property)) || !property.name || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) || property.name.text === "__proto__" || properties.has(property.name.text)) { safe = false; break; }
      // `this`/super may observe any sibling or escape the entire receiver. Classes remain whole.
      const inspect = (node: ts.Node): void => {
        if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword || ts.isDecorator(node)) safe = false;
        ts.forEachChild(node, inspect);
      };
      inspect(property);
      let value = ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
      while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value) || ts.isTypeAssertionExpression(value))) value = value.expression;
      // Nested state can be mutated by a method call or escape through an alias.
      // `as const` is erased, not a runtime freeze. Until those effects are proven,
      // retain all methods that may influence a consumer through that shared state.
      if (value && (ts.isArrayLiteralExpression(value) || ts.isObjectLiteralExpression(value))) safe = false;
      if (ts.isMethodDeclaration(property) || value && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) {
        if (capturesState(ts.isMethodDeclaration(property) ? property : value!, declaration, checkedCaptures)) safe = false;
      }
      if (value && ts.isIdentifier(value)) {
        // A function stored by reference can observe its receiver, and an object-valued
        // alias can share mutable state between otherwise separate properties.
        if (!primitive(symbolAt(value)?.valueDeclaration)) safe = false;
      }
      properties.set(property.name.text, property);
    }
    if (!safe) continue;
    const shellText = source.text.slice(statement.pos, object.getStart(source)) + "{}" + source.text.slice(object.end, statement.end);
    const shell = codeFingerprintText(ts, ts.createSourceFile(source.fileName, shellText, ts.ScriptTarget.Latest, true));
    objects.set(statement, { statement, object, properties, shell });
    names.add(declaration.name.text);
  }
  const top = (node: ts.Node): ts.Statement | undefined => {
    while (node.parent && !ts.isSourceFile(node.parent)) node = node.parent;
    return node.parent ? node as ts.Statement : undefined;
  };
  // Aliases are resolved by their binding, not by spelling. Unknown/namespace uses fall back upstream.
  for (const source of sources.values()) for (const statement of source.statements) if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.name) names.add(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const binding of clause.namedBindings.elements) names.add(binding.name.text);
    if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.add(clause.namedBindings.name.text);
  }
  const scan = () => {
    if (scanned) return;
    scanned = true;
    for (const source of sources.values()) {
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && names.has(node.text)) {
          const declarations = symbolAt(node)?.declarations ?? [];
          for (const declaration of declarations) {
            if ((declaration as ts.NamedDeclaration).name === node || ts.isExportSpecifier(node.parent)) continue;
            const binding = imported(declaration);
            if (binding?.file && binding.name === undefined) {
              // An opaque namespace may mutate a re-exported receiver. Do not guess its target.
              for (const object of objects.keys()) unsafe.add(object);
            }
            const statement = binding ? binding.file && binding.name ? exported(binding.file, binding.name)?.at(-1) : undefined : top(declaration);
            const object = statement && objects.get(statement);
            // A shadowing parameter/local belongs to this statement, but is not its receiver.
            if (object && (binding || declaration === object.statement.declarationList.declarations[0]) && readMember(ts, node) === undefined) unsafe.add(object.statement);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  return {
    get(statement: ts.Statement): ObjectInfo | undefined {
      if (!objects.has(statement)) return undefined;
      scan();
      return unsafe.has(statement) ? undefined : objects.get(statement);
    },
  };
}
