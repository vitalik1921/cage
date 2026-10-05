import type ts from "typescript";
import type { SourceLocation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { collectDocComments, createReporter, docCommentBefore, readAllowedTags, reportUnboundTags } from "./doc-comments.ts";
import { parseNames, type DocTag } from "./metadata.ts";
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
}

const SUPPORTED = "`@implements` needs an exported, named class, function or const";

/** An exported class, function or const: something a design could describe. */
export interface ExportedDeclaration {
  name: string;
  kind: "class" | "function" | "const";
  location: SourceLocation;
  /** Whether an `@implements` tag is written on it, accepted or not. */
  claimed: boolean;
}

export interface ImplementationsOfFile {
  found: FoundImplementation[];
  /** Every exported class, function and const of the file, for the question of what the designs leave out. */
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

  /** The names a statement exports as code: a class, a function with a body, the names of a const statement. */
  const exportedBy = (statement: ts.Statement): { name: ts.Identifier; kind: ExportedDeclaration["kind"] }[] => {
    const { exported, declared } = modifiersOf(statement);
    if (!exported || declared) return [];
    if (ts.isClassDeclaration(statement) && statement.name) return [{ name: statement.name, kind: "class" }];
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) return [{ name: statement.name, kind: "function" }];
    if (ts.isVariableStatement(statement) && (statement.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      return statement.declarationList.declarations.flatMap((declaration) => (ts.isIdentifier(declaration.name) ? [{ name: declaration.name, kind: "const" as const }] : []));
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

  for (const statement of sourceFile.statements) {
    const comment = hasTags ? docCommentBefore(ts, sourceFile, statement) : undefined;
    const claimed = comment?.tags.some((tag) => tag.name === "implements") ?? false;
    for (const { name, kind } of exportedBy(statement)) exported.push({ name: name.text, kind, location: locate(name.getStart(sourceFile)), claimed });
    if (!comment || !claimed) continue;
    bound.add(comment.pos);
    const tags = readAllowedTags(comment.tags, ["implements", "description"], "on an implementation", report).get("implements") ?? [];
    if (tags.length === 0) continue;
    // A declaration may implement several contracts: `@implements A B`, or one tag per contract.
    const contracts = new Map<string, DocTag>();
    for (const tag of tags) {
      const names = parseNames(tag.text);
      if (!names) {
        report("E_TAG_FORMAT", "`@implements` without contract names", tag.start);
        continue;
      }
      for (const name of names) if (!contracts.has(name)) contracts.set(name, tag);
    }
    const target = describe(statement);
    if (typeof target === "string") {
      report("E_UNSUPPORTED_DECLARATION", `${target}`, tags[0].start);
      continue;
    }
    for (const [contract, tag] of contracts) {
      found.push({ contract, name: target.name.text, kind: target.kind, location: locate(target.name.getStart(sourceFile)), tagLocation: locate(tag.start) });
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
  const written = comments.flatMap((comment) => comment.tags.filter((candidate) => candidate.name === "implements").flatMap((candidate) => parseNames(candidate.text) ?? []));
  return { found, exported, rejected: written.filter((name) => !accepted.has(name)), diagnostics };
}
