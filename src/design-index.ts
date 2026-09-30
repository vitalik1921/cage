import type ts from "typescript";
import type { Diagnostic } from "./diagnostic.ts";
import { emptyIndex, type Contract, type ContractMember, type DesignIndex, type SourceLocation } from "./design-model.ts";
import { findModuleCycles } from "./graph.ts";
import { isDocComment, parseDocTags, parseInvariant, parseNames, tagKind, type DocTag } from "./metadata.ts";
import type { TypeScript } from "./typescript.ts";

/** The generated module of one design, parsed, with the way back to the MDX. */
export interface DesignSourceFile {
  moduleId: string;
  sourceFile: ts.SourceFile;
  /** The MDX location of an offset in the generated text. */
  locate: (offset: number) => SourceLocation;
  /** Index of the design block that holds an offset of the generated text. */
  blockOf: (offset: number) => number;
}

/** Where an import in a design leads: another design of the scope, a generated file outside it, or anything else. */
export type ImportTarget = { moduleId: string } | "out-of-scope" | "other";

export type ResolveImport = (specifier: ts.StringLiteralLike, from: ts.SourceFile) => ImportTarget;

interface PendingUse {
  contract: Contract;
  name: string;
  location: SourceLocation;
}

const BLOCK_CONTENT = "A ts design block may contain only `import type` declarations and exported interface or type declarations.";

/**
 * Builds the registry of contracts, data types, invariants and declared
 * dependencies from the design modules, and validates everything that does
 * not need type information: what a block may declare, tags, contract
 * shapes, references, imports and module cycles.
 */
export function indexDesigns(
  ts: TypeScript,
  designs: readonly DesignSourceFile[],
  resolveImport: ResolveImport,
): { index: DesignIndex; diagnostics: Diagnostic[] } {
  const index = emptyIndex();
  const diagnostics: Diagnostic[] = [];
  const uses: PendingUse[] = [];
  // Contracts whose invariants were written, even if rejected: "no invariants" would be a consequence, not a finding.
  const withInvariantTags = new Set<Contract>();
  for (const design of designs) readDesign(ts, design, resolveImport, index, uses, withInvariantTags, diagnostics);

  const contracts = new Map<string, Contract>();
  for (const contract of index.contracts) {
    const first = contracts.get(contract.name);
    if (!first) {
      contracts.set(contract.name, contract);
      continue;
    }
    diagnostics.push({
      code: "E_CONTRACT_DUPLICATE",
      severity: "error",
      message: `Contract name "${contract.name}" is already used; contract names are unique in the whole scope.`,
      ...contract.location,
      contract: contract.name,
      related: [{ message: "The other declaration.", ...first.location }],
    });
  }

  for (const use of uses) {
    const target = contracts.get(use.name);
    const problem = !target
      ? `\`@uses ${use.name}\`: there is no contract with this name.`
      : target.name === use.contract.name
        ? `\`@uses ${use.name}\`: a contract cannot use itself.`
        : undefined;
    if (problem !== undefined) {
      diagnostics.push({ code: "E_REFERENCE_UNKNOWN", severity: "error", message: problem, ...use.location, contract: use.contract.name });
    } else {
      index.edges.push({
        kind: "uses",
        from: use.contract.name,
        to: use.name,
        fromModule: use.contract.module,
        toModule: target!.module,
        location: use.location,
      });
    }
  }

  for (const cycle of findModuleCycles(index.edges)) {
    const [first, ...rest] = cycle;
    diagnostics.push({
      code: "E_DESIGN_CYCLE",
      severity: "error",
      message: `Design modules depend on each other in a cycle: ${[...cycle.map((edge) => edge.fromModule), first.fromModule].join(" → ")}.`,
      ...first.location,
      related: rest.map((edge) => ({ message: `${edge.fromModule} depends on ${edge.toModule} here.`, ...edge.location })),
    });
  }

  // A scope without contracts is an error, unless that is a consequence of the errors above.
  if (index.contracts.length === 0 && diagnostics.length === 0) {
    diagnostics.push({ code: "E_NO_CONTRACTS", severity: "error", message: "The designs declare no contract: no exported interface is marked `@contract`." });
  }
  for (const contract of index.contracts) {
    if (contracts.get(contract.name) === contract && !withInvariantTags.has(contract)) {
      diagnostics.push({
        code: "W_NO_INVARIANTS",
        severity: "warning",
        message: `Contract "${contract.name}" has no \`@invariant\`: only its types can be checked.`,
        ...contract.location,
        contract: contract.name,
      });
    }
  }
  return { index, diagnostics };
}

function readDesign(
  ts: TypeScript,
  design: DesignSourceFile,
  resolveImport: ResolveImport,
  index: DesignIndex,
  uses: PendingUse[],
  withInvariantTags: Set<Contract>,
  diagnostics: Diagnostic[],
): void {
  const { sourceFile, moduleId } = design;
  const text = sourceFile.text;
  const report = (code: string, message: string, offset: number, extra?: Partial<Diagnostic>) =>
    diagnostics.push({ code, severity: "error", message, ...design.locate(offset), ...extra });

  const comments = collectComments(ts, sourceFile);
  for (const comment of comments) {
    // Deliberately wider than what the compiler honours (any case, any position, any suffix): nothing may slip through.
    const pragma = /@ts-(nocheck|ignore|expect-error)/i.exec(text.slice(comment.pos, comment.end));
    if (pragma) {
      report(
        "E_UNSUPPORTED_DECLARATION",
        `\`@ts-${pragma[1].toLowerCase()}\` would hide type errors of the design; it is not allowed in the comments of ts design blocks.`,
        comment.pos + pragma.index,
      );
    }
  }

  // TypeScript merges interfaces of the same name without a word; contracts and data types are declared once.
  const interfaces = new Map<string, "contract" | "data">();
  // Doc comments bound to a declaration that can carry harness tags; every other doc comment must not have any.
  const bound = new Set<number>();
  /**
   * Tags of the doc comment directly before a node: only whitespace may separate them. A comment that ends the
   * line of the previous declaration is about that declaration, and a comment in an earlier block never documents
   * a later block: neither is bound.
   */
  const docTags = (node: ts.Node): DocTag[] => {
    const start = node.getStart(sourceFile);
    const last = commentsBefore(ts, text, node.getFullStart()).at(-1);
    if (!last || !isDocComment(text.slice(last.pos, last.end))) return [];
    const endsPreviousLine = ts.getTrailingCommentRanges(text, node.getFullStart())?.some((range) => range.pos === last.pos) && /[\r\n]/.test(text.slice(last.end, start));
    if (endsPreviousLine || design.blockOf(last.pos) !== design.blockOf(start)) return [];
    bound.add(last.pos);
    return parseDocTags(text.slice(last.pos, last.end), last.pos);
  };
  /** A rejected declaration is one mistake: the tags inside it are not reported as misplaced on top of it. */
  const bindDocsWithin = (node: ts.Node) => {
    for (const comment of comments) if (comment.pos >= node.getStart(sourceFile) && comment.end <= node.getEnd()) bound.add(comment.pos);
  };

  /** Checks the tags of one declaration against the tags allowed there and returns the allowed ones by name. */
  const readTags = (tags: readonly DocTag[], allowed: readonly string[], where: string): Map<string, DocTag[]> => {
    const byName = new Map<string, DocTag[]>();
    for (const tag of tags) {
      const kind = tagKind(tag.name);
      if (kind === "standard" || /^ts-/i.test(tag.name)) continue;
      if (kind === "unknown") report("E_UNKNOWN_TAG", `Unknown tag \`@${tag.name}\`.`, tag.start);
      else if (kind === "unsupported") report("E_UNSUPPORTED_TAG", `\`@${tag.name}\` is not supported.`, tag.start);
      else if (!allowed.includes(tag.name)) report("E_TAG_LOCATION", `\`@${tag.name}\` is not allowed ${where}.`, tag.start);
      else if (tag.suffix !== "") report("E_TAG_FORMAT", `\`@${tag.name}${tag.suffix}\`: a space must follow the tag name.`, tag.start);
      else byName.set(tag.name, [...(byName.get(tag.name) ?? []), tag]);
    }
    return byName;
  };

  /** `@description`: at most one, with a text. Returns null when there is none or it is invalid. */
  const readDescription = (tags: ReadonlyMap<string, DocTag[]>): string | null => {
    const [first, second] = tags.get("description") ?? [];
    if (second) report("E_TAG_FORMAT", "`@description` is given more than once.", second.start);
    if (first && first.text === "") report("E_TAG_FORMAT", "`@description` has no text.", first.start);
    return first && first.text !== "" ? first.text : null;
  };

  /** `declared` holds the invariants of the contract declaration being read: ids are unique within it. */
  const readInvariants = (tags: ReadonlyMap<string, DocTag[]>, contract: string, member: string | null, declared: Map<string, SourceLocation>) => {
    for (const tag of tags.get("invariant") ?? []) {
      const invariant = parseInvariant(tag.text);
      if (!invariant) {
        report("E_TAG_FORMAT", "`@invariant` needs an id (lowercase letters, digits and hyphens, starting with a letter) followed by a text.", tag.start);
        continue;
      }
      const location = design.locate(tag.start);
      const first = declared.get(invariant.id);
      if (first) {
        report("E_INVARIANT_DUPLICATE", `Invariant id "${invariant.id}" is already used in contract "${contract}".`, tag.start, {
          contract,
          invariant: invariant.id,
          related: [{ message: "The other invariant.", ...first }],
        });
        continue;
      }
      declared.set(invariant.id, location);
      index.invariants.push({ contract, ...invariant, member, location });
    }
  };

  const readContract = (declaration: ts.InterfaceDeclaration, tags: ReadonlyMap<string, DocTag[]>, description: string | null) => {
    const name = declaration.name.text;
    const unsupported = (what: string, node: ts.Node) =>
      report("E_UNSUPPORTED_DECLARATION", `Contract "${name}": ${what}.`, node.getStart(sourceFile), { contract: name });

    if (declaration.typeParameters) unsupported("generic contracts are not supported", declaration.typeParameters[0]);
    if (declaration.heritageClauses) unsupported("`extends` is not supported", declaration.heritageClauses[0]);

    const invariants = new Map<string, SourceLocation>();
    let hasInvariantTags = tags.has("invariant");
    readInvariants(tags, name, null, invariants);
    const members: ContractMember[] = [];
    const calls: ts.CallSignatureDeclaration[] = [];
    for (const member of declaration.members) {
      let memberName: string | null = null;
      if (ts.isCallSignatureDeclaration(member)) {
        calls.push(member);
      } else if (ts.isMethodSignature(member) && ts.isIdentifier(member.name)) {
        memberName = member.name.text;
        if (member.questionToken) unsupported("optional methods are not supported", member);
      } else {
        unsupported("a contract has only methods with plain names, or a single call signature", member);
        // Its doc comment goes with it: the member is already reported, the tags on it are not a second mistake.
        docTags(member);
        continue;
      }
      if (member.typeParameters) unsupported("generic signatures are not supported", member.typeParameters[0]);

      // A call signature has no name: its invariants belong to the contract as a whole.
      const memberTags = readTags(docTags(member), ["description", "invariant"], "on a contract method");
      const memberDescription = readDescription(memberTags);
      hasInvariantTags ||= memberTags.has("invariant");
      readInvariants(memberTags, name, memberName, invariants);
      if (memberName === null) continue;
      if (members.some((other) => other.name === memberName)) unsupported("overloads are not supported", member);
      else members.push({ name: memberName, description: memberDescription, location: design.locate(member.getStart(sourceFile)) });
    }
    if (calls.length > 1) unsupported("overloads are not supported", calls[1]);
    if (calls.length > 0 && members.length > 0) unsupported("a contract has either methods or a call signature, not both", calls[0]);
    if (declaration.members.length === 0) unsupported("a contract needs at least one method or a call signature", declaration.name);

    const contract: Contract = {
      name,
      module: moduleId,
      description,
      shape: calls.length > 0 ? "callable" : "object",
      members,
      location: design.locate(declaration.name.getStart(sourceFile)),
    };
    index.contracts.push(contract);
    if (hasInvariantTags) withInvariantTags.add(contract);
    for (const tag of tags.get("uses") ?? []) {
      const names = parseNames(tag.text);
      if (!names) report("E_TAG_FORMAT", "`@uses` needs one or more contract names.", tag.start);
      for (const used of names ?? []) {
        // The same name in a later `@uses` of this contract is the same dependency.
        if (!uses.some((use) => use.contract === contract && use.name === used)) uses.push({ contract, name: used, location: design.locate(tag.start) });
      }
    }
  };

  const readDeclaration = (declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration) => {
    const name = declaration.name.text;
    const at = declaration.name.getStart(sourceFile);
    const modifiers = declaration.modifiers?.map((modifier) => modifier.kind) ?? [];
    if (!modifiers.includes(ts.SyntaxKind.ExportKeyword) || modifiers.includes(ts.SyntaxKind.DefaultKeyword)) {
      report("E_UNSUPPORTED_DECLARATION", `"${name}" must be a named export: a design declares only its public types.`, at);
    }

    const all = docTags(declaration);
    const isContract = all.some((tag) => tag.name === "contract");
    const tags = readTags(
      all,
      isContract ? ["contract", "data", "description", "uses", "invariant"] : ["contract", "data", "description"],
      isContract ? "on a contract" : "on a data type",
    );
    const markers = [...(tags.get("contract") ?? []), ...(tags.get("data") ?? [])];
    for (const marker of markers) if (marker.text !== "") report("E_TAG_FORMAT", `\`@${marker.name}\` takes no text; the name comes from the declaration.`, marker.start);
    if (markers.length === 0) {
      report("E_UNSUPPORTED_DECLARATION", `"${name}" must be marked \`@contract\` or \`@data\` in the doc comment right before it.`, at);
      bindDocsWithin(declaration);
      return;
    }
    if (markers.length > 1) {
      report("E_TAG_FORMAT", `"${name}" has more than one \`@contract\` / \`@data\` marker.`, markers[1].start);
      bindDocsWithin(declaration);
      return;
    }

    const description = readDescription(tags);
    if (!tags.has("description")) report("E_DESCRIPTION_MISSING", `"${name}" needs a \`@description\`.`, at);

    if (ts.isInterfaceDeclaration(declaration)) {
      const kind = isContract ? "contract" : "data";
      const earlier = interfaces.get(name);
      interfaces.set(name, earlier ?? kind);
      // Two contracts of one name are reported with the contracts of all modules.
      if (earlier && !(earlier === "contract" && isContract)) {
        report("E_UNSUPPORTED_DECLARATION", `"${name}" is declared more than once; declaration merging is not supported.`, at);
        bindDocsWithin(declaration);
        return;
      }
    }
    if (!isContract) {
      index.data.push({ name, module: moduleId, description, location: design.locate(at) });
    } else if (ts.isInterfaceDeclaration(declaration)) {
      readContract(declaration, tags, description);
    } else {
      report("E_UNSUPPORTED_DECLARATION", `Contract "${name}" must be an interface.`, at);
      bindDocsWithin(declaration);
    }
  };

  const readImport = (declaration: ts.ImportDeclaration) => {
    const at = declaration.getStart(sourceFile);
    const specifier = declaration.moduleSpecifier;
    if (!declaration.importClause?.isTypeOnly || !ts.isStringLiteral(specifier)) {
      report("E_DESIGN_IMPORT", "A ts design block may import only with `import type`.", at);
      return;
    }
    const target = resolveImport(specifier, sourceFile);
    if (target === "out-of-scope") {
      report("E_DESIGN_OUT_OF_SCOPE", `"${specifier.text}" is a generated design module whose design document is not in the scope.`, specifier.getStart(sourceFile));
    } else if (target === "other") {
      report("E_DESIGN_IMPORT", `"${specifier.text}" is not the design.generated file of another design; a design may import only types of other designs.`, specifier.getStart(sourceFile));
    } else if (target.moduleId === moduleId) {
      report("E_DESIGN_IMPORT", "A design cannot import its own generated module.", specifier.getStart(sourceFile));
    } else if (!index.edges.some((edge) => edge.kind === "type-import" && edge.fromModule === moduleId && edge.toModule === target.moduleId)) {
      index.edges.push({ kind: "type-import", fromModule: moduleId, toModule: target.moduleId, location: design.locate(at) });
    }
  };

  for (const statement of sourceFile.statements) {
    // Whatever names another module is an import, so that the type check never follows it.
    const namesModule =
      (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) ||
      (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference));
    if (ts.isImportDeclaration(statement)) readImport(statement);
    else if (namesModule) report("E_DESIGN_IMPORT", "A ts design block may refer to another module only with `import type`.", statement.getStart(sourceFile));
    else if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) readDeclaration(statement);
    else if (statement.kind !== ts.SyntaxKind.EmptyStatement) report("E_UNSUPPORTED_DECLARATION", BLOCK_CONTENT, statement.getStart(sourceFile));
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportTypeNode(node)) {
      report("E_DESIGN_IMPORT", "Inline `import(...)` types are not allowed; use an `import type` declaration.", node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const comment of comments) {
    const commentText = text.slice(comment.pos, comment.end);
    if (bound.has(comment.pos) || !isDocComment(commentText)) continue;
    readTags(parseDocTags(commentText, comment.pos), [], "here: it must be in the doc comment right before a contract, a data type or a contract method");
  }
}

/** The comments between the previous token and `position`, where a token or the end of the file starts. */
function commentsBefore(ts: TypeScript, text: string, position: number): ts.CommentRange[] {
  // "Trailing" comments are those on the line of the previous token, "leading" ones the rest.
  return [...(ts.getTrailingCommentRanges(text, position) ?? []), ...(ts.getLeadingCommentRanges(text, position) ?? [])];
}

/** Every comment of a file. Comments are trivia of tokens, so each one precedes a token or the end of the file. */
function collectComments(ts: TypeScript, sourceFile: ts.SourceFile): ts.CommentRange[] {
  const text = sourceFile.text;
  const comments = new Map<number, ts.CommentRange>();
  const visit = (node: ts.Node) => {
    // A doc comment is itself a child node of what it precedes; its content is not tokens of the program.
    if (ts.isJSDoc(node)) return;
    if (ts.isToken(node)) for (const range of commentsBefore(ts, text, node.getFullStart())) comments.set(range.pos, range);
    node.getChildren(sourceFile).forEach(visit);
  };
  visit(sourceFile);
  return [...comments.values()].sort((a, b) => a.pos - b.pos);
}
