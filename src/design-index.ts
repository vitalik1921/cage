import type ts from "typescript";
import type { Diagnostic } from "./diagnostic.ts";
import { emptyIndex, type Contract, type ContractMember, type DesignIndex, type LockedDeclaration, type LockLevel, type SourceLocation } from "./design-model.ts";
import { findModuleCycles } from "./graph.ts";
import { collectComments, docCommentBefore, readAllowedTags } from "./doc-comments.ts";
import { isDocComment, parseDocTags, parseInvariant, parseNames, type DocTag } from "./metadata.ts";
import type { TypeScript } from "./typescript.ts";

/** The generated module of one design, parsed, with the way back to the MDX. */
export interface DesignSourceFile {
  moduleId: string;
  sourceFile: ts.SourceFile;
  /** The MDX location of an offset in the generated text. */
  locate: (offset: number) => SourceLocation;
  /** Index of the design block that holds an offset of the generated text. */
  blockOf: (offset: number) => number;
  /** A module specifier as the document writes it; the generated text may spell a relative one differently. */
  writtenSpecifier: (specifier: ts.StringLiteralLike) => string;
}

/** Where an import in a design leads: another design of the scope (with the names of its documents), a design document outside it, or anything else. */
export type ImportTarget = { moduleId: string; documents: string[] } | "out-of-scope" | "other";

export type ResolveImport = (specifier: ts.StringLiteralLike, from: ts.SourceFile) => ImportTarget;

interface PendingUse {
  contract: Contract;
  name: string;
  location: SourceLocation;
}

/** What is known about locks before every design is read. */
interface PendingLocks {
  /** A type of some design that a locked declaration refers to, at the first place it does. */
  uses: { locked: LockedDeclaration; module: string; name: string; location: SourceLocation }[];
  /** Declarations with a lock tag, even a rejected one: "not locked" would be a consequence, not a finding. */
  tagged: Set<string>;
}

const declarationKey = (module: string, name: string) => `${module}\n${name}`;

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
  const locks: PendingLocks = { uses: [], tagged: new Set() };
  for (const design of designs) readDesign(ts, design, resolveImport, index, uses, withInvariantTags, locks, diagnostics);

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

  // A lock holds only as far as what it is made of: an open type inside a locked declaration can still change it.
  const declared = new Map([...index.contracts.map((contract) => [contract, "contract"] as const), ...index.data.map((data) => [data, "data type"] as const)]);
  for (const use of locks.uses) {
    const target = [...declared.keys()].find((candidate) => candidate.module === use.module && candidate.name === use.name);
    if (!target || target.lock !== null || locks.tagged.has(declarationKey(target.module, target.name))) continue;
    const subject = `${use.locked.kind === "contract" ? "Contract" : "Data type"} "${use.locked.name}"`;
    diagnostics.push({
      code: "W_LOCK_OPEN_TYPE",
      severity: "warning",
      message: `${subject} is \`@${use.locked.level}\`, but it uses ${declared.get(target)} "${target.name}", which is not locked: a change to "${target.name}" changes it too. Mark "${target.name}" \`@final\` or \`@extendable\`.`,
      ...use.location,
      ...(use.locked.kind === "contract" ? { contract: use.locked.name } : {}),
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
  locks: PendingLocks,
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
  /** Tags of the doc comment directly before a node. A comment in an earlier block never documents a later block. */
  const docTags = (node: ts.Node): DocTag[] => {
    const comment = docCommentBefore(ts, sourceFile, node);
    if (!comment || design.blockOf(comment.pos) !== design.blockOf(node.getStart(sourceFile))) return [];
    bound.add(comment.pos);
    return comment.tags;
  };
  /** A rejected declaration is one mistake: the tags inside it are not reported as misplaced on top of it. */
  const bindDocsWithin = (node: ts.Node) => {
    for (const comment of comments) if (comment.pos >= node.getStart(sourceFile) && comment.end <= node.getEnd()) bound.add(comment.pos);
  };

  const readTags = (tags: readonly DocTag[], allowed: readonly string[], where: string) => readAllowedTags(tags, allowed, where, report);

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

  const readContract = (declaration: ts.InterfaceDeclaration, tags: ReadonlyMap<string, DocTag[]>, description: string | null, lock: LockLevel | null) => {
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
      lock,
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
    // Without a marker nobody knows yet what the declaration is: its other tags are not judged as those of a data type.
    const isData = all.some((tag) => tag.name === "data");
    const tags = readTags(
      all,
      isContract || !isData ? ["contract", "data", "description", "uses", "invariant", "final", "extendable"] : ["contract", "data", "description", "final", "extendable"],
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
    if (tags.has("final") || tags.has("extendable")) locks.tagged.add(declarationKey(moduleId, name));
    const lock = readLock(declaration, tags);
    const firstInvariant = index.invariants.length;
    if (!isContract) {
      index.data.push({ name, module: moduleId, description, lock, location: design.locate(at) });
    } else if (ts.isInterfaceDeclaration(declaration)) {
      readContract(declaration, tags, description, lock);
    } else {
      report("E_UNSUPPORTED_DECLARATION", `Contract "${name}" must be an interface.`, at);
      bindDocsWithin(declaration);
      return;
    }
    if (lock) {
      // The text of an invariant is recorded on one line, like a signature.
      const invariants = index.invariants.slice(firstInvariant).map((invariant) => [invariant.id, invariant.text.replace(/\s+/g, " ")]);
      const locked: LockedDeclaration = {
        name,
        module: moduleId,
        kind: isContract ? "contract" : "data",
        level: lock,
        members: signaturesOf(declaration),
        invariants: Object.fromEntries(invariants),
        location: design.locate(at),
      };
      index.locked.push(locked);
      lockedReferences.push({ locked, references: referencesOf(declaration) });
    }
  };

  /** `@final` or `@extendable`: at most one of them, without text. */
  const readLock = (declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration, tags: ReadonlyMap<string, DocTag[]>): LockLevel | null => {
    const [first, second] = [...(tags.get("final") ?? []), ...(tags.get("extendable") ?? [])].sort((a, b) => a.start - b.start);
    if (!first) return null;
    if (second) {
      report("E_TAG_FORMAT", "A declaration is either `@final` or `@extendable`, and says so once.", second.start);
      return null;
    }
    if (first.text !== "") {
      report("E_TAG_FORMAT", `\`@${first.name}\` takes no text.`, first.start);
      return null;
    }
    if (first.name === "extendable" && !ts.isInterfaceDeclaration(declaration)) {
      report("E_TAG_LOCATION", "`@extendable` needs an interface: a type alias has no members to add to. Use `@final`, or declare an interface.", first.start);
      return null;
    }
    return first.name as LockLevel;
  };

  // A signature is recorded as the printer writes it, on one line: layout, separators and comments of the document
  // do not matter, nor does the quote style of a string literal; what is inside a literal is kept as it is.
  const printer = ts.createPrinter({ removeComments: true });
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
  const print = (node: ts.Node): string => {
    scanner.setText(printer.printNode(ts.EmitHint.Unspecified, node, sourceFile));
    let text = "";
    let end = 0;
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if (text !== "" && scanner.getTokenStart() > end) text += " ";
      text += token === ts.SyntaxKind.StringLiteral ? JSON.stringify(scanner.getTokenValue()) : scanner.getTokenText();
      end = scanner.getTokenEnd();
    }
    return text;
  };
  /**
   * Members by name. What is not a named member has a key that no name can be: `:type` for the type of an alias,
   * `:call`, `:construct` and `:index` for such signatures, `:type-parameters` and `:extends` for the declaration.
   */
  const signaturesOf = (declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration): Record<string, string> => {
    const signatures = new Map<string, string>();
    const add = (key: string, text: string) => signatures.set(key, signatures.has(key) ? `${signatures.get(key)} ${text}` : text);
    if (declaration.typeParameters) add(":type-parameters", declaration.typeParameters.map(print).join(", "));
    if (ts.isTypeAliasDeclaration(declaration)) {
      add(":type", print(declaration.type));
    } else {
      for (const clause of declaration.heritageClauses ?? []) add(":extends", print(clause));
      for (const member of declaration.members) {
        const key = member.name ? print(member.name) : ts.isCallSignatureDeclaration(member) ? ":call" : ts.isConstructSignatureDeclaration(member) ? ":construct" : ":index";
        add(key, print(member));
      }
    }
    // Built from entries, so that a member called `__proto__` or `toString` is an ordinary key.
    return Object.fromEntries(signatures);
  };

  /** Local name to what it is in another design; `name` is null for a namespace import. */
  const imported = new Map<string, { moduleId: string; name: string | null }>();
  const lockedReferences: { locked: LockedDeclaration; references: TypeName[] }[] = [];
  interface TypeName {
    namespace: string | null;
    name: string;
    offset: number;
  }
  /** The type names a declaration refers to, apart from its own type parameters. */
  const referencesOf = (declaration: ts.Node): TypeName[] => {
    const own = new Set<string>();
    const found: TypeName[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeParameterDeclaration(node)) own.add(node.name.text);
      const written = ts.isTypeReferenceNode(node) ? node.typeName : ts.isExpressionWithTypeArguments(node) ? node.expression : undefined;
      if (written && ts.isIdentifier(written)) {
        found.push({ namespace: null, name: written.text, offset: written.getStart(sourceFile) });
      } else if (written && (ts.isQualifiedName(written) || ts.isPropertyAccessExpression(written))) {
        const [namespace, member] = ts.isQualifiedName(written) ? [written.left, written.right] : [written.expression, written.name];
        if (ts.isIdentifier(namespace)) found.push({ namespace: namespace.text, name: member.text, offset: written.getStart(sourceFile) });
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    return found.filter((reference) => reference.namespace !== null || !own.has(reference.name));
  };

  const readImport = (declaration: ts.ImportDeclaration) => {
    const at = declaration.getStart(sourceFile);
    const specifier = declaration.moduleSpecifier;
    if (!declaration.importClause?.isTypeOnly || !ts.isStringLiteral(specifier)) {
      report("E_DESIGN_IMPORT", "A ts design block may import only with `import type`.", at);
      return;
    }
    const target = resolveImport(specifier, sourceFile);
    const written = design.writtenSpecifier(specifier);
    if (target === "out-of-scope") {
      report("E_DESIGN_OUT_OF_SCOPE", `"${written}" is a design document that is not in the scope.`, specifier.getStart(sourceFile));
    } else if (target === "other") {
      report("E_DESIGN_IMPORT", `"${written}" is not a design document (*.cage.mdx); a design may import only types of other designs.`, specifier.getStart(sourceFile));
    } else if (target.moduleId === moduleId) {
      report("E_DESIGN_IMPORT", "A design cannot import itself: the documents of one directory are one design, and they share their types.", specifier.getStart(sourceFile));
    } else if (!target.documents.includes(written.split("/").at(-1) ?? "")) {
      report("E_DESIGN_IMPORT", `"${written}" is not a document of the design of ${target.moduleId}; it has ${target.documents.join(", ")}.`, specifier.getStart(sourceFile));
    } else {
      const bindings = declaration.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) imported.set(bindings.name.text, { moduleId: target.moduleId, name: null });
      else for (const element of bindings?.elements ?? []) imported.set(element.name.text, { moduleId: target.moduleId, name: (element.propertyName ?? element.name).text });
      if (!index.edges.some((edge) => edge.kind === "type-import" && edge.fromModule === moduleId && edge.toModule === target.moduleId)) {
        index.edges.push({ kind: "type-import", fromModule: moduleId, toModule: target.moduleId, location: design.locate(at) });
      }
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

  // Imports may come in any block, so names are resolved once the whole design is read.
  for (const { locked, references } of lockedReferences) {
    const seen = new Set<string>();
    for (const { namespace, name, offset } of references) {
      const source = imported.get(namespace ?? name);
      const target =
        namespace !== null ? (source?.name === null ? { module: source.moduleId, name } : undefined) : source ? (source.name === null ? undefined : { module: source.moduleId, name: source.name }) : { module: moduleId, name };
      if (!target || seen.has(declarationKey(target.module, target.name))) continue;
      seen.add(declarationKey(target.module, target.name));
      locks.uses.push({ locked, ...target, location: design.locate(offset) });
    }
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
