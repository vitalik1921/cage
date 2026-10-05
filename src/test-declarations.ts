import type ts from "typescript";
import type { SourceLocation, TestStatus } from "./design-model.ts";
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
  status: TestStatus;
  inactiveBecause?: string;
  /** The runner hooks in effect for the test: the file's top-level ones, then those of each enclosing suite. */
  setup: SourceLocation[];
  location: SourceLocation;
}

/** A suite that disables everything in it, as its text shows: `describe.skip`, `describe.todo`, `{ skip: true }`. */
interface Disabled {
  status: "skipped" | "todo";
  because: string;
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
  /** The exports that register setup or teardown for the tests of their suite (or of the file). */
  hooks: ReadonlySet<string>;
}

const ADAPTERS: Readonly<Record<TestAdapter, AdapterRules>> = {
  "node:test": { module: "node:test", modifiers: new Set(["skip", "only", "todo"]), carriers: new Set(["*", "default", "test"]), defaultIsTest: true, globals: false, hooks: new Set(["before", "after", "beforeEach", "afterEach"]) },
  vitest: {
    module: "vitest",
    modifiers: new Set(["skip", "only", "todo", "concurrent", "sequential", "fails", "shuffle"]),
    carriers: new Set(["*"]),
    defaultIsTest: false,
    globals: true,
    hooks: new Set(["beforeAll", "afterAll", "beforeEach", "afterEach"]),
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

  /**
   * Whether the call disables its declaration: a `skip` or `todo` modifier in the callee chain, or a
   * `skip` / `todo` option that is literally `true` or a non-empty string (node:test takes a reason).
   * An option computed at run time is not known here and counts as enabled.
   */
  const disabledBy = (call: ts.CallExpression, callee: ts.Expression): Disabled | undefined => {
    for (let target = callee; ts.isPropertyAccessExpression(target); target = target.expression) {
      if (target.name.text === "skip" || target.name.text === "todo") return { status: target.name.text === "skip" ? "skipped" : "todo", because: `\`.${target.name.text}\`` };
    }
    for (const argument of call.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
        const name = property.name.text;
        if (name !== "skip" && name !== "todo") continue;
        const value = property.initializer;
        const on = value.kind === ts.SyntaxKind.TrueKeyword || ((ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) && value.text !== "");
        if (on) return { status: name === "skip" ? "skipped" : "todo", because: `the \`${name}\` option` };
      }
    }
    return undefined;
  };

  /** Whether the test's callback has a body that could run anything: none at all, or an empty block, cannot. */
  /**
   * What an argument of a test call is, as a callback: a function this file shows (inline, or named and
   * resolved by `callbackFunction`), something callable whose body the file does not show (an import, a
   * `let`, the result of a call: its type has call signatures), something the compiler cannot type (`any`,
   * `unknown`), or not a callback at all — a title, an options object, a timeout, any value whose type
   * has no call signatures.
   */
  const asCallback = (argument: ts.Expression): { kind: "function"; fn: ts.SignatureDeclaration } | { kind: "callable" | "untyped" } | undefined => {
    if (ts.isStringLiteralLike(argument) || ts.isTemplateExpression(argument) || ts.isNumericLiteral(argument) || ts.isObjectLiteralExpression(argument) || ts.isArrayLiteralExpression(argument)) return undefined;
    if (argument.kind === ts.SyntaxKind.TrueKeyword || argument.kind === ts.SyntaxKind.FalseKeyword || argument.kind === ts.SyntaxKind.NullKeyword) return undefined;
    const fn = callbackFunction(argument);
    if (fn) return { kind: "function", fn };
    const type = checker.getTypeAtLocation(argument);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { kind: "untyped" };
    const members = type.isUnion() ? type.types : [type];
    if (members.some((member) => member.getCallSignatures().length > 0)) return { kind: "callable" };
    if (members.some((member) => (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return { kind: "untyped" };
    return undefined;
  };

  /**
   * Whether the test's callback has a body that could run anything. The callback is the argument that is
   * callable, whatever its position — node:test takes `(name, options, fn)`, Vitest `(name, fn, timeout)`
   * and `(name, options, fn)` — so options and timeouts before or after it are passed over. A function the
   * file shows is read; a callable it does not show, or an argument it cannot type, counts as active.
   */
  const emptiness = (call: ts.CallExpression): string | undefined => {
    const candidates = call.arguments.map((argument) => ({ argument, callback: asCallback(argument) })).filter((candidate) => candidate.callback !== undefined);
    if (candidates.length === 0) return "has no callback";
    const chosen = candidates.find((candidate) => candidate.callback!.kind !== "untyped") ?? candidates[0];
    const callback = chosen.callback!;
    if (callback.kind !== "function") return undefined;
    const fn = callback.fn;
    if (!("body" in fn) || !fn.body || !ts.isBlock(fn.body) || fn.body.statements.length !== 0) return undefined;
    if (fn === chosen.argument) return "has an empty body";
    return `has an empty body (\`${chosen.argument.getText(sourceFile)}\`, line ${sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1})`;
  };

  /** Whether a callee is a runner hook, by its binding like `kindOf`: `beforeEach`, `setup` imported as it, `t.afterEach`, a global. */
  const isHook = (callee: ts.Expression): boolean => {
    if (ts.isIdentifier(callee)) {
      const imported = importedAs(callee);
      return imported !== undefined && rules.hooks.has(imported);
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const imported = importedAs(callee.expression);
      return imported !== undefined && rules.carriers.has(imported) && rules.hooks.has(callee.name.text);
    }
    return false;
  };

  /** The hook statements among `statements`, also in blocks and control flow there; never inside a function, so not in a nested suite. */
  const hooksIn = (statements: readonly ts.Statement[]): SourceLocation[] => {
    const found: SourceLocation[] = [];
    const walk = (node: ts.Node): void => {
      if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && isHook(node.expression.expression)) {
        found.push(locate(node.getStart(sourceFile)));
        return;
      }
      ts.forEachChild(node, walk);
    };
    for (const statement of statements) walk(statement);
    return found;
  };

  /**
   * The function a callback argument is, when the file shows it: an inline function, or a name or a
   * property of this file bound to one — a function declaration, a method, a `const` holding a function,
   * or a trivial alias or object property leading to one, followed a few steps with cycle protection. An
   * import, a `let`, a call or anything computed is not followed: undefined, and the test counts as active.
   */
  const callbackFunction = (expression: ts.Expression): ts.SignatureDeclaration | undefined => {
    const seen = new Set<ts.Node>();
    let current: ts.Node = expression;
    for (let step = 0; step < 16; step++) {
      if (seen.has(current)) return undefined;
      seen.add(current);
      if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) return current;
      let symbol: ts.Symbol | undefined;
      if (ts.isIdentifier(current)) symbol = checker.getSymbolAtLocation(current);
      else if (ts.isPropertyAccessExpression(current)) symbol = checker.getSymbolAtLocation(current.name);
      else return undefined;
      let declaration: ts.Declaration | undefined = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isShorthandPropertyAssignment(declaration)) {
        const value = checker.getShorthandAssignmentValueSymbol(declaration);
        declaration = value?.valueDeclaration ?? value?.declarations?.[0];
      }
      // Only this file's own bindings: an import is an alias to code the file does not show.
      if (!declaration || declaration.getSourceFile() !== sourceFile) return undefined;
      if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
        current = declaration;
      } else if (ts.isVariableDeclaration(declaration) && declaration.initializer && ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
        current = declaration.initializer;
      } else if (ts.isPropertyAssignment(declaration)) {
        current = declaration.initializer;
      } else {
        return undefined;
      }
    }
    return undefined;
  };

  const readTitle = (call: ts.CallExpression, managed: boolean, what: string): string => {
    const [title] = call.arguments;
    if (title && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) return title.text;
    if (managed) report("E_UNSUPPORTED_DECLARATION", `annotated ${what} without a plain string title`, (title ?? call).getStart(sourceFile));
    return "";
  };

  const readSuite = (statement: ts.ExpressionStatement, call: ts.CallExpression, callee: ts.Expression, inherited: Scope, path: string[], disabled: Disabled | undefined, setup: SourceLocation[]) => {
    const comment = docCommentBefore(ts, sourceFile, statement);
    const managed = comment?.tags.some((tag) => isBindingTag(tag.name)) ?? false;
    let scope = inherited;
    if (comment && managed) {
      bound.add(comment.pos);
      const tags = readAllowedTags(comment.tags, ["tests", "description"], "on a suite; `@covers` goes on a test", report);
      scope = readContext(tags, comment.tags, "a suite", inherited);
    }
    const title = readTitle(call, managed, "suite");
    // A disabled suite disables what it holds; the outermost reason is the one that counts.
    const own = disabledBy(call, callee);
    const inside = disabled ?? (own && { status: own.status, because: `${own.because} on its suite "${title}"` });
    // The callback is not always the last argument: runners also take options or a timeout after it.
    const callback = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && ts.isBlock(callback.body)) {
      const inner = [...setup, ...hooksIn(callback.body.statements)];
      for (const statement of callback.body.statements) visit(statement, scope, [...path, title], inside, inner);
    } else if (managed) {
      report("E_UNSUPPORTED_DECLARATION", "annotated suite without an inline block callback", call.getStart(sourceFile));
    }
  };

  /**
   * The contracts that a `@tests` tag puts in effect for a suite or a test,
   * or the inherited ones when there is no such tag. A rejected tag makes the
   * scope invalid: whatever it names may well be tested there.
   */
  const readContext = (tags: ReadonlyMap<string, DocTag[]>, all: readonly DocTag[], what: string, inherited: Scope): Scope => {
    const [tag, second] = tags.get("tests") ?? [];
    if (second) report("E_TAG_FORMAT", `\`@tests\` given twice on the ${what}`, second.start);
    const contracts = tag && parseNames(tag.text);
    if (tag && contracts === undefined) report("E_TAG_FORMAT", "`@tests` without contract names", tag.start);
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

  const readTest = (statement: ts.ExpressionStatement, call: ts.CallExpression, callee: ts.Expression, inherited: Scope, path: string[], disabled: Disabled | undefined, setup: SourceLocation[]) => {
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
      if (!ids) report("E_TAG_FORMAT", "`@covers` without invariant ids", tag.start);
      else if (!scope) report("E_TEST_CONTEXT", "`@covers` without `@tests`", tag.start);
      else for (const id of ids) if (!covers.some((other) => other.id === id)) covers.push({ id, location: locate(tag.start) });
    }
    if (scope && scope !== "invalid") {
      const own = disabledBy(call, callee);
      const empty = emptiness(call);
      const state: { status: TestStatus; inactiveBecause?: string } = disabled
        ? { status: disabled.status, inactiveBecause: `${disabled.status} by ${disabled.because}` }
        : own
          ? { status: own.status, inactiveBecause: `${own.status} by ${own.because}` }
          : empty
            ? { status: "empty", inactiveBecause: empty }
            : { status: "active" };
      tests.push({ title, suitePath: path, context: scope, covers, ...state, setup, location: locate(statement.getStart(sourceFile)) });
    }
  };

  const visit = (node: ts.Node, context: Scope, path: string[], disabled: Disabled | undefined, setup: SourceLocation[]): void => {
    // Functions and classes are not declaration scopes: what a helper or a test callback registers is only known at run time.
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      // `it.each(cases)("title", fn)` declares one test with its template title; the callee is the inner `it.each` call.
      const callee = node.expression.expression;
      const table = ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "each" ? callee.expression.expression : undefined;
      const kind = kindOf(table ?? callee);
      if (kind === "suite") return readSuite(node, node.expression, table ?? callee, context, path, disabled, setup);
      if (kind === "test") return readTest(node, node.expression, table ?? callee, context, path, disabled, setup);
    }
    ts.forEachChild(node, (child) => visit(child, context, path, disabled, setup));
  };
  // The file's top-level hooks set up every test of the file, wherever they stand in it.
  visit(sourceFile, undefined, [], undefined, hooksIn(sourceFile.statements));

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
