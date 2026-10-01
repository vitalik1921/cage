import type ts from "typescript";
import type { SourceLocation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { collectDocComments, createReporter, docCommentBefore, readAllowedTags, reportUnboundTags } from "./doc-comments.ts";
import { isBindingTag, parseInvariantIds, parseNames, type DocTag } from "./metadata.ts";
import type { TypeScript } from "./typescript.ts";

/** The contract a suite or a test is about, as written in its `@tests` tag. */
export interface TestContext {
  /** One or more: a test through a port may demonstrate what the port and the service behind it promise. */
  contracts: string[];
  location: SourceLocation;
}

/**
 * What a rejected tag was trying to link: a contract as a whole, from a
 * rejected `@tests`, or some of its invariants, from a rejected `@covers`.
 * The rejection is reported; "has no test" for the same thing would be its
 * consequence.
 */
export interface RejectedLink {
  /** Null when the tag was written where no contract is in effect: it could be about any contract. */
  contract: string | null;
  invariants: string[] | "all";
}

/** A test declaration inside a `@tests` suite, before its contract and invariants are looked up. */
export interface FoundTest {
  title: string;
  suitePath: string[];
  context: TestContext;
  covers: { id: string; location: SourceLocation }[];
  location: SourceLocation;
}

/** The contract in effect: from the enclosing suites or the test itself; "invalid" when its `@tests` tag was rejected, so that nothing under it is reported again. */
type Scope = TestContext | "invalid" | undefined;

export type TestAdapter = "node:test" | "vitest";

interface AdapterRules {
  /** The module whose exports declare suites and tests. */
  module: string;
  /** Properties that change how a declaration runs, not what it declares: `it.skip`, `describe.concurrent.only`. */
  modifiers: ReadonlySet<string>;
  /** Imports that are objects carrying `describe`, `it`, ...: the namespace, and for node:test its default export, `test`. */
  carriers: ReadonlySet<string>;
  /** Whether the default import is itself the test function. */
  defaultIsTest: boolean;
  /** Whether the runner can also provide its functions as globals, declared by its own type definitions. */
  globals: boolean;
}

const ADAPTERS: Readonly<Record<TestAdapter, AdapterRules>> = {
  "node:test": { module: "node:test", modifiers: new Set(["skip", "only", "todo"]), carriers: new Set(["*", "default", "test"]), defaultIsTest: true, globals: false },
  vitest: {
    module: "vitest",
    modifiers: new Set(["skip", "only", "todo", "concurrent", "sequential", "fails", "shuffle"]),
    carriers: new Set(["*"]),
    defaultIsTest: false,
    globals: true,
  },
};

const KINDS: ReadonlyMap<string, "suite" | "test"> = new Map([
  ["describe", "suite"],
  ["suite", "suite"],
  ["it", "test"],
  ["test", "test"],
]);

/**
 * Finds the suite and test declarations of a test file and reads their
 * `@tests` and `@covers` tags. Nothing is executed. A call is a declaration
 * when its callee is bound to an import from the runner's module, whatever
 * the local name, or to a global that the runner's own types declare: a
 * function or parameter that merely is called `it` is not one.
 *
 * Declarations are statements at the top level of the file, in blocks and
 * control flow there, and in the inline callbacks of suites. What a test
 * callback or any other function contains is not a declaration.
 * `file` is the project-relative path used in locations.
 */
export function readTestDeclarations(
  ts: TypeScript,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  file: string,
  adapter: TestAdapter,
): { tests: FoundTest[]; contexts: TestContext[]; rejected: RejectedLink[]; diagnostics: Diagnostic[] } {
  const rules = ADAPTERS[adapter];
  const tests: FoundTest[] = [];
  const contexts: TestContext[] = [];
  const rejected: RejectedLink[] = [];
  const diagnostics: Diagnostic[] = [];
  const { locate, report } = createReporter(ts, sourceFile, file, diagnostics);
  const bound = new Set<number>();

  /** What an identifier is bound to in the runner: an export name, "default", or "*" for the namespace. */
  const importedAs = (identifier: ts.Identifier): string | undefined => {
    const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
    if (!declaration) return undefined;
    // A global such as `describe` is a variable declared in the type definitions of the runner's package.
    if (rules.globals && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      const definedIn = declaration.getSourceFile().fileName.replaceAll("\\", "/");
      return definedIn.includes(`/node_modules/${rules.module}/`) ? declaration.name.text : undefined;
    }
    const from = (clause: ts.ImportClause) => (ts.isStringLiteral(clause.parent.moduleSpecifier) && clause.parent.moduleSpecifier.text === rules.module ? clause : undefined);
    if (ts.isImportSpecifier(declaration)) return from(declaration.parent.parent) && (declaration.propertyName ?? declaration.name).text;
    if (ts.isNamespaceImport(declaration)) return from(declaration.parent) && "*";
    if (ts.isImportClause(declaration)) return from(declaration) && "default";
    return undefined;
  };

  /** Whether a callee declares a suite or a test: `it`, `it.skip`, `describe.concurrent.only`, `ns.describe`, `ns.it.todo`, and so on; `it.each(...)` is unwrapped by the caller. */
  const kindOf = (callee: ts.Expression): "suite" | "test" | undefined => {
    let target = callee;
    while (ts.isPropertyAccessExpression(target) && rules.modifiers.has(target.name.text)) target = target.expression;
    if (ts.isIdentifier(target)) {
      const imported = importedAs(target);
      if (imported === "default") return rules.defaultIsTest ? "test" : undefined;
      return imported === undefined ? undefined : KINDS.get(imported);
    }
    if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.expression)) {
      const imported = importedAs(target.expression);
      return imported !== undefined && rules.carriers.has(imported) ? KINDS.get(target.name.text) : undefined;
    }
    return undefined;
  };

  const readTitle = (call: ts.CallExpression, managed: boolean, what: string): string => {
    const [title] = call.arguments;
    if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) return title.text;
    if (managed) report("E_UNSUPPORTED_DECLARATION", `An annotated ${what} needs a title that is a string or a template without substitutions.`, (title ?? call).getStart(sourceFile));
    return "";
  };

  const readSuite = (statement: ts.ExpressionStatement, call: ts.CallExpression, inherited: Scope, path: string[]) => {
    const comment = docCommentBefore(ts, sourceFile, statement);
    const managed = comment?.tags.some((tag) => isBindingTag(tag.name)) ?? false;
    let scope = inherited;
    if (comment && managed) {
      bound.add(comment.pos);
      const tags = readAllowedTags(comment.tags, ["tests", "description"], "on a suite; `@covers` goes on a test", report);
      scope = readContext(tags, comment.tags, "a suite", inherited);
    }
    const title = readTitle(call, managed, "suite");
    // The callback is not always the last argument: runners also take options or a timeout after it.
    const callback = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
      for (const inner of callback.body.statements) visit(inner, scope, [...path, title]);
    } else if (managed) {
      report("E_UNSUPPORTED_DECLARATION", "An annotated suite needs an inline function with a block body as its callback: its tests are read from the statements of that block.", call.getStart(sourceFile));
    }
  };

  /**
   * The contracts that a `@tests` tag puts in effect for a suite or a test,
   * or the inherited ones when there is no such tag. A rejected tag makes the
   * scope invalid: whatever it names may well be tested there.
   */
  const readContext = (tags: ReadonlyMap<string, DocTag[]>, all: readonly DocTag[], what: string, inherited: Scope): Scope => {
    const [tag, second] = tags.get("tests") ?? [];
    if (second) report("E_TAG_FORMAT", `\`@tests\` is given more than once; name the contracts ${what} is about in one tag: \`@tests A B\`.`, second.start);
    const contracts = tag && parseNames(tag.text);
    if (tag && contracts === undefined) report("E_TAG_FORMAT", "`@tests` needs one or more contract names: `@tests Quota`, or `@tests Webhook Quota` for a test that demonstrates both.", tag.start);
    const written = all.filter((candidate) => candidate.name === "tests");
    if (written.length === 0) return inherited;
    if (tag && contracts !== undefined && !second) {
      const scope = { contracts: [...new Set(contracts)], location: locate(tag.start) };
      contexts.push(scope);
      return scope;
    }
    // What was written before an inline tag still says which contract was meant.
    for (const name of written.flatMap((candidate) => parseNames(candidate.text.replace(/\s@[a-z-]+[\s\S]*$/, "")) ?? [])) rejected.push({ contract: name, invariants: "all" });
    return "invalid";
  };

  const readTest = (statement: ts.ExpressionStatement, call: ts.CallExpression, inherited: Scope, path: string[]) => {
    const comment = docCommentBefore(ts, sourceFile, statement);
    const managed = comment?.tags.some((tag) => isBindingTag(tag.name)) ?? false;
    let coverTags: DocTag[] = [];
    let scope = inherited;
    if (comment && managed) {
      bound.add(comment.pos);
      const tags = readAllowedTags(comment.tags, ["tests", "covers", "description"], "on a test", report);
      // A test may name its own contract: for a test outside any suite, or in a suite that holds tests of several contracts.
      scope = readContext(tags, comment.tags, "a test", inherited);
      coverTags = tags.get("covers") ?? [];
    }
    const title = readTitle(call, managed, "test");
    const covers: FoundTest["covers"] = [];
    for (const tag of coverTags) {
      const ids = parseInvariantIds(tag.text);
      if (!ids) report("E_TAG_FORMAT", "`@covers` needs one or more invariant ids.", tag.start);
      else if (!scope) report("E_TEST_CONTEXT", "`@covers` needs a contract: add `@tests Name` to this test, or put the test in a suite marked `@tests`.", tag.start);
      else for (const id of ids) if (!covers.some((other) => other.id === id)) covers.push({ id, location: locate(tag.start) });
    }
    if (scope && scope !== "invalid") tests.push({ title, suitePath: path, context: scope, covers, location: locate(statement.getStart(sourceFile)) });
  };

  const visit = (node: ts.Node, context: Scope, path: string[]): void => {
    // Functions and classes are not declaration scopes: what a helper or a test callback registers is only known at run time.
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      // `it.each(cases)("title", fn)` declares one test with its template title; the callee is the inner `it.each` call.
      const callee = node.expression.expression;
      const table = ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "each" ? callee.expression.expression : undefined;
      const kind = kindOf(table ?? callee);
      if (kind === "suite") return readSuite(node, node.expression, context, path);
      if (kind === "test") return readTest(node, node.expression, context, path);
    }
    ts.forEachChild(node, (child) => visit(child, context, path));
  };
  visit(sourceFile, undefined, []);

  const comments = collectDocComments(ts, sourceFile);
  // Whatever was written as a link and did not become one was rejected above, wherever and however it was written:
  // a misplaced tag, glued punctuation, a test outside any suite. It still says what the author meant to link.
  const misplaced = comments.filter((comment) => !bound.has(comment.pos)).flatMap((comment) => comment.tags.filter((tag) => tag.name === "tests"));
  for (const name of misplaced.flatMap((tag) => parseNames(tag.text) ?? [])) rejected.push({ contract: name, invariants: "all" });
  const linked = new Set(tests.flatMap((declaration) => declaration.covers.map((cover) => cover.id)));
  const covers = comments.flatMap((comment) => comment.tags.filter((tag) => tag.name === "covers"));
  const unlinked = covers.flatMap((tag) => parseInvariantIds(tag.text) ?? []).filter((id) => !linked.has(id));
  if (unlinked.length > 0) rejected.push({ contract: null, invariants: unlinked });

  reportUnboundTags(
    comments,
    bound,
    `here: \`@tests\` goes right before a describe/suite or an it/test call, \`@covers\` right before an it/test call of ${rules.module}, as statements outside any other function`,
    report,
  );
  return { tests, contexts, rejected, diagnostics };
}
