import type ts from "typescript";
import type { SourceLocation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { collectDocComments, createReporter, docCommentBefore, readAllowedTags, reportUnboundTags } from "./doc-comments.ts";
import { parseName, parseNames, type DocTag } from "./metadata.ts";
import type { TypeScript } from "./typescript.ts";

/** An exported declaration tagged `@implements`, before its contract is looked up. */
export interface FoundImplementation {
  /** The contract name as written in the tag. */
  contract: string;
  name: string;
  kind: "class" | "function" | "const";
  location: SourceLocation;
  /** Where the `@implements` tag is. */
  tagLocation: SourceLocation;
  /** Static members of a class, explicitly bound separately from its instance. */
  surface?: "static";
}

const SUPPORTED = "`@implements` needs an exported, named class, function or const";

/** An exported class, function or non-scalar const: something a design could describe. */
export interface ExportedDeclaration {
  name: string;
  kind: "class" | "function" | "const";
  location: SourceLocation;
  /** Whether an `@implements` tag is written on it, accepted or not. */
  claimed: boolean;
}

export interface ImplementationsOfFile {
  found: FoundImplementation[];
  /** Exported declarations that need design coverage; plain scalar constants are data. */
  exported: ExportedDeclaration[];
  /** Contract names in `@implements` tags that were rejected: such a contract was given an implementation, only not a valid one. */
  rejected: string[];
  diagnostics: Diagnostic[];
}

/**
 * Reads the `@implements` tags of an ordinary source file. Only doc comments
 * with a harness tag are looked at; the rest of the file is not linted.
 * `file` is the project-relative path used in locations. For a file known
 * to mention no tag, `hasTags` false leaves its comments unread: only its
 * exported declarations are listed.
 */
export function readImplementations(ts: TypeScript, sourceFile: ts.SourceFile, file: string, hasTags = true): ImplementationsOfFile {
  const found: FoundImplementation[] = [];
  const exported: ExportedDeclaration[] = [];
  const diagnostics: Diagnostic[] = [];
  const { locate, report } = createReporter(ts, sourceFile, file, diagnostics);
  const bound = new Set<number>();

  const modifiersOf = (statement: ts.Statement) => {
    const kinds = (ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined)?.map((modifier) => modifier.kind) ?? [];
    return {
      exported: kinds.includes(ts.SyntaxKind.ExportKeyword) && !kinds.includes(ts.SyntaxKind.DefaultKeyword),
      declared: kinds.includes(ts.SyntaxKind.DeclareKeyword),
      abstract: kinds.includes(ts.SyntaxKind.AbstractKeyword),
    };
  };

  /** Behaviour a statement declares, exported or not, leaving standalone scalar constants out of design coverage. */
  const behaviourOf = (statement: ts.Statement): { name: ts.Identifier; kind: ExportedDeclaration["kind"] }[] => {
    if (modifiersOf(statement).declared) return [];
    if (ts.isClassDeclaration(statement) && statement.name) return [{ name: statement.name, kind: "class" }];
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) return [{ name: statement.name, kind: "function" }];
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) && !scalarConstant(ts, declaration.initializer) ? [{ name: declaration.name, kind: "const" as const }] : []));
    }
    return [];
  };

  /** The exported name and kind of a statement that can implement a contract, or why it cannot. */
  const describe = (statement: ts.Statement): { name: ts.Identifier; kind: FoundImplementation["kind"] } | string => {
    const { exported, declared, abstract } = modifiersOf(statement);
    if (declared) return "a `declare` declaration has no code: it is not an implementation";
    if (ts.isClassDeclaration(statement)) {
      if (!exported || !statement.name) return SUPPORTED;
      if (abstract) return "an abstract class cannot be checked against a contract";
      // A generic class is checked at the defaults of its type parameters; without them there is no one type to check.
      if (statement.typeParameters?.some((parameter) => !parameter.default)) return "a generic class can be checked against a contract only when every type parameter has a default";
      return { name: statement.name, kind: "class" };
    }
    if (ts.isFunctionDeclaration(statement)) {
      if (!exported || !statement.name) return SUPPORTED;
      const name = statement.name.text;
      const overloaded = sourceFile.statements.some((other) => other !== statement && ts.isFunctionDeclaration(other) && other.name?.text === name);
      if (overloaded) return "an overloaded function cannot be checked against a contract";
      if (!statement.body) return "a function without a body is not an implementation";
      return { name: statement.name, kind: "function" };
    }
    if (ts.isVariableStatement(statement)) {
      const [declaration, ...others] = statement.declarationList.declarations;
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (!exported || !isConst || others.length > 0 || !ts.isIdentifier(declaration.name)) return `${SUPPORTED}; a const statement declares one plain name`;
      return { name: declaration.name, kind: "const" };
    }
    return SUPPORTED;
  };

  // Local behaviour exported by a list, `class A {}; export { A, A as B };`, needs coverage as much as `export class A`: once per declaration, where it is declared.
  const listed = new Set(
    sourceFile.statements.flatMap((statement) =>
      ts.isExportDeclaration(statement) && !statement.moduleSpecifier && !statement.isTypeOnly && statement.exportClause && ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.filter((element) => !element.isTypeOnly && element.name.text !== "default").map((element) => (element.propertyName ?? element.name).text)
        : [],
    ),
  );
  const reported = new Set<string>();

  for (const statement of sourceFile.statements) {
    const comment = hasTags ? docCommentBefore(ts, sourceFile, statement) : undefined;
    const claimed = comment?.tags.some((tag) => (tag.name === "implements" || tag.name === "implements-static")) ?? false;
    const { exported: direct } = modifiersOf(statement);
    for (const { name, kind } of behaviourOf(statement)) {
      if (!direct && !listed.has(name.text)) continue;
      // Overloads, `export function f` with `export { f as g }`: one declaration, one gap.
      if (reported.has(name.text)) continue;
      reported.add(name.text);
      exported.push({ name: name.text, kind, location: locate(name.getStart(sourceFile)), claimed });
    }
    if (!comment || !claimed) continue;
    bound.add(comment.pos);
    const allowed = readAllowedTags(comment.tags, ["implements", "implements-static", "description"], "on an implementation", report);
    const tags = [...(allowed.get("implements") ?? []), ...(allowed.get("implements-static") ?? [])];
    if (tags.length === 0) continue;
    // One binding per surface, and it names exactly one contract: no lists, no second tag, not even with the same name.
    // A malformed binding rejects the declaration's other one too: checked alone, the class would seem to have one surface only.
    const bindings: { contract: string; tag: DocTag }[] = [];
    let malformed = false;
    for (const surface of ["implements", "implements-static"]) {
      const [tag, ...repeated] = allowed.get(surface) ?? [];
      if (!tag) continue;
      const contract = parseName(tag.text);
      if (repeated.length > 0) report("E_TAG_FORMAT", `\`@${surface}\` given twice: a declaration implements one contract, write a single \`@${surface} Name\``, repeated[0].start);
      else if (contract === undefined) report("E_TAG_FORMAT", parseNames(tag.text) ? `\`@${surface}\` with several names: a declaration implements one contract, write \`@${surface} Name\`` : `\`@${surface}\` without a contract name`, tag.start);
      else bindings.push({ contract, tag });
      malformed ||= contract === undefined || repeated.length > 0;
    }
    const [instance, statics] = bindings.length === 2 ? bindings : [];
    if (instance && statics && instance.contract === statics.contract) {
      report("E_TAG_FORMAT", `\`@implements ${instance.contract}\` and \`@implements-static ${statics.contract}\`: one contract bound to both surfaces of a class is ambiguous`, statics.tag.start);
      continue;
    }
    if (malformed) continue;
    const target = describe(statement);
    if (typeof target === "string") {
      report("E_UNSUPPORTED_DECLARATION", `${target}`, tags[0].start);
      continue;
    }
    for (const { contract, tag } of bindings) {
      if (tag.name === "implements-static" && target.kind !== "class") {
        report("E_TAG_LOCATION", "`@implements-static` requires a class", tag.start);
        continue;
      }
      found.push({ ...(tag.name === "implements-static" ? { surface: "static" as const } : {}), contract, name: target.name.text, kind: target.kind, location: locate(target.name.getStart(sourceFile)), tagLocation: locate(tag.start) });
    }
  }

  if (!hasTags) return { found, exported, rejected: [], diagnostics };
  const comments = collectDocComments(ts, sourceFile);
  reportUnboundTags(
    comments,
    bound,
    "here: `@implements` goes in the doc comment right before an exported class, function or const, above its decorators if it has any; `@tests` and `@covers` belong in a test file, one that the `tests` patterns of the configuration match",
    report,
  );
  // Every `@implements` that did not become an implementation was rejected above, wherever and however it was written.
  const accepted = new Set(found.map((implementation) => implementation.contract));
  const written = comments.flatMap((comment) => comment.tags.filter((candidate) => (candidate.name === "implements" || candidate.name === "implements-static")).flatMap((candidate) => parseNames(candidate.text) ?? []));
  return { found, exported, rejected: written.filter((name) => !accepted.has(name)), diagnostics };
}

/** Only syntax that visibly computes a scalar value; opaque expressions still need coverage. */
function scalarConstant(ts: TypeScript, node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) return scalarConstant(ts, node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
  if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
  if (ts.isPrefixUnaryExpression(node)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.TildeToken].includes(node.operator) && scalarConstant(ts, node.operand);
  if (ts.isBinaryExpression(node)) {
    const scalarOperators = [
      ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken,
      ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
      ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
      ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken, ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ];
    return scalarOperators.includes(node.operatorToken.kind) && scalarConstant(ts, node.left) && scalarConstant(ts, node.right);
  }
  if (ts.isConditionalExpression(node)) return scalarConstant(ts, node.condition) && scalarConstant(ts, node.whenTrue) && scalarConstant(ts, node.whenFalse);
  if (ts.isTemplateExpression(node)) return node.templateSpans.every(span => scalarConstant(ts, span.expression));
  return false;
}
