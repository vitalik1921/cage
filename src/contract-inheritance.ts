import type ts from "typescript";
import { shapeChecker } from "./contract-shape.ts";
import { signaturePrinter, type DesignSourceFile } from "./design-index.ts";
import type { ContractMember, DesignIndex, Invariant, SourceLocation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { TypeScript } from "./typescript.ts";

/** A `@contract` or `@data` declaration of a design, as a base of a contract can be. */
interface DesignDeclaration {
  kind: "contract" | "data";
  name: string;
  module: string;
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
  design: DesignSourceFile;
}

/** A declaration of an installed package's types, named through an `import type` of the design. */
interface PackageDeclaration {
  kind: "package" | "project";
  name: string;
  /** The package name, from the path of its declaration file. */
  module: string;
}

type Base = DesignDeclaration | PackageDeclaration;

const keyOf = ({ kind, module, name }: { kind: string; module: string; name: string }) => `${kind === "package" || kind === "project" ? kind : "design"}\n${module}\n${name}`;

/**
 * Completes the contracts that extend other declarations, once the designs type-check. What a contract inherits
 * is the compiler's resolved type: its effective public members, overloads, generic methods and call signatures
 * as the compiler has merged and checked them, so a conflict between bases or a redeclaration is the compiler's
 * to judge. A base is a `@contract` or `@data` declaration of a design, local or imported, or a declaration of an
 * installed package's types named through an import. The invariants of every base contract up the chain come
 * along with their origin, each ancestor once however many paths lead to it, whether or not the contract
 * redeclares the member they are about.
 *
 * The contract then has inherited members and invariants in the index, an `extends` edge per design base, the
 * design bases' declarations in its review source, and inherited signatures and invariants in its lock.
 *
 * Errors: a base that is neither a design declaration nor a package's; one invariant id from two places; a
 * contract's API that reaches it other than along `extends`, which would leave its invariants behind; and what the
 * exact comparison of implementations cannot check at the top of a contract, an index or a construct signature.
 */
export function resolveInheritance(ts: TypeScript, checker: ts.TypeChecker, designs: readonly DesignSourceFile[], index: DesignIndex, importedOrigin?: (file: string) => { kind: "package" | "project"; module: string } | undefined): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const byFile = new Map(designs.map((design) => [design.sourceFile, design]));
  const print = signaturePrinter(ts);
  const shape = shapeChecker(ts, checker);

  const declarationOf = (node: ts.Node): DesignDeclaration | undefined => {
    if (!(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) || !ts.isSourceFile(node.parent)) return undefined;
    const design = byFile.get(node.parent);
    if (!design) return undefined;
    const name = node.name.text;
    const at = (entry: { module: string; name: string }) => entry.module === design.moduleId && entry.name === name;
    // The first declaration of a name is the one the index holds; a second one is already an error.
    const first = design.sourceFile.statements.find((statement) => (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name);
    if (first !== node) return undefined;
    if (index.contracts.some(at)) return { kind: "contract", name, module: design.moduleId, node, design };
    if (index.data.some(at)) return { kind: "data", name, module: design.moduleId, node, design };
    return undefined;
  };
  /** What a written base names, through imports; undefined when it is neither a design's declaration nor a package's. */
  const baseOf = (type: ts.ExpressionWithTypeArguments): Base | undefined => {
    const name = ts.isPropertyAccessExpression(type.expression) ? type.expression.name : type.expression;
    let first: ts.Expression = type.expression;
    while (ts.isPropertyAccessExpression(first)) first = first.expression;
    // A package's types reach a design only through its imports, whatever the compiler finds among the globals.
    const imported = !!((checker.getSymbolAtLocation(first)?.flags ?? 0) & ts.SymbolFlags.Alias);
    let symbol = checker.getSymbolAtLocation(name);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    for (const declaration of symbol?.declarations ?? []) {
      const found = declarationOf(declaration);
      if (found) return found;
    }
    for (const declaration of symbol?.declarations ?? []) {
      const file = declaration.getSourceFile();
      const origin = importedOrigin?.(file.fileName);
      const named = ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration);
      if (imported && named && origin) return { ...origin, name: symbol!.name };
    }
    return undefined;
  };
  const heritageOf = (node: DesignDeclaration["node"]) =>
    ts.isInterfaceDeclaration(node) ? (node.heritageClauses ?? []).filter((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword).flatMap((clause) => clause.types) : [];
  /** The design declaration a member was written in: an interface, or the type alias whose type literal holds it. */
  const ownerOf = (member: ts.Node): DesignDeclaration | undefined => {
    for (let node: ts.Node | undefined = member.parent; node; node = node.parent) {
      if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return declarationOf(node);
    }
    return undefined;
  };
  /** Whether a member is declared inside a generic declaration: its resolved type then depends on the arguments. */
  const generic = (member: ts.Node): boolean => {
    for (let node: ts.Node | undefined = member.parent; node && !ts.isSourceFile(node); node = node.parent) {
      if ((ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) && (node.typeParameters?.length ?? 0) > 0) return true;
    }
    return false;
  };
  const hidden = (symbol: ts.Symbol) =>
    (symbol.declarations ?? []).some(
      (node) =>
        (ts.isClassElement(node) && node.name !== undefined && ts.isPrivateIdentifier(node.name)) ||
        (ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword)),
    );

  /** A type parameter's argument where the walk below met it, with the bindings of that place. */
  interface Bound {
    node: ts.TypeNode;
    bindings: Bindings;
  }
  type Bindings = ReadonlyMap<ts.Symbol, Bound>;
  const resolveAlias = (symbol: ts.Symbol | undefined) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  /** The bindings of a generic declaration's parameters for one reference: its arguments, or the defaults. */
  const bind = (parameters: readonly ts.TypeParameterDeclaration[] | undefined, args: readonly ts.TypeNode[] | undefined, bindings: Bindings): Bindings => {
    if (!parameters?.length) return new Map();
    const bound = new Map<ts.Symbol, Bound>();
    parameters.forEach((parameter, i) => {
      const symbol = checker.getSymbolAtLocation(parameter.name);
      const argument = args?.[i];
      if (symbol && argument) bound.set(symbol, { node: argument, bindings });
      else if (symbol && parameter.default) bound.set(symbol, { node: parameter.default, bindings: bound });
    });
    return bound;
  };

  /** Where a base copies the API of a contract that is not an ancestor, or where that cannot be told. */
  interface Extraction {
    site: ts.Node;
    contract: DesignDeclaration | undefined;
  }
  /**
   * The places where a base hands on the API of a contract other than along `extends`: an indexed access on a type
   * whose members a contract declares (`Writer["write"]`, `Writer[K]` in a mapped type, through `Record`, `Pick` and
   * any alias), standing for a member of the base or for the base itself, or the contract itself in the base's
   * structure (`Writer & {…}`). Names are resolved as symbols, type parameters by the arguments of each reference.
   * A field whose type is a contract, or a nested field, holds the contract; it does not copy its API.
   */
  const extractionsOf = (start: ts.ExpressionWithTypeArguments, self: DesignDeclaration, ancestors: readonly DesignDeclaration[]): Extraction[] => {
    const found: Extraction[] = [];
    const exempt = (declaration: DesignDeclaration) => keyOf(declaration) === keyOf(self) || ancestors.some((ancestor) => keyOf(ancestor) === keyOf(declaration));
    let steps = 0;
    const exhausted = (site: ts.Node, depth: number) => {
      if (++steps <= 10000 && depth <= 64) return false;
      found.push({ site, contract: undefined });
      return true;
    };
    /** The contract a type's members are declared by, other than this one and its ancestors. */
    const contractBehind = (type: ts.Type): DesignDeclaration | undefined => {
      const declarations = [
        ...checker.getPropertiesOfType(type).flatMap((property) => property.declarations ?? []),
        ...[ts.SignatureKind.Call, ts.SignatureKind.Construct].flatMap((kind) => checker.getSignaturesOfType(type, kind).flatMap((signature) => signature.getDeclaration() ?? [])),
      ];
      for (const declaration of declarations) {
        const owner = ownerOf(declaration);
        if (owner?.kind === "contract" && !exempt(owner)) return owner;
      }
      return undefined;
    };
    /**
     * What a type node stands for where the walk met it: type parameters replaced by their arguments and aliases,
     * transparent or not, by what they are made of, each with the bindings of its own reference. Undefined for a
     * type parameter no argument says anything about (an `infer`, a mapped key).
     */
    const resolve = (node: ts.TypeNode, bindings: Bindings): Bound | undefined => {
      for (let current: Bound = { node, bindings }, hops = 0; hops < 64; hops++) {
        const at = current.node;
        if (ts.isParenthesizedTypeNode(at)) {
          current = { node: at.type, bindings: current.bindings };
          continue;
        }
        if (!ts.isTypeReferenceNode(at)) return current;
        const symbol = checker.getSymbolAtLocation(at.typeName);
        if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) {
          const next = current.bindings.get(symbol);
          if (!next) return undefined;
          current = next;
          continue;
        }
        const named = target(at, current.bindings);
        if (!named || !ts.isTypeAliasDeclaration(named.declaration)) return current;
        current = { node: named.declaration.type, bindings: named.bindings };
      }
      return undefined;
    };
    /** Whether a type node means the same wherever it is met: no type parameter in it is declared outside it. */
    const closed = (node: ts.Node): boolean => {
      let open = false;
      const visit = (child: ts.Node) => {
        if (open) return;
        if (ts.isTypeReferenceNode(child)) {
          const symbol = checker.getSymbolAtLocation(child.typeName);
          if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) {
            const declaration = symbol.declarations?.[0];
            open = !declaration || declaration.getSourceFile() !== node.getSourceFile() || declaration.pos < node.pos || declaration.end > node.end;
          }
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
      return !open;
    };
    /** The keys an index selects, when they are known where the walk met it: literals, or a union of them. */
    const keysOf = (node: ts.TypeNode, bindings: Bindings): string[] | undefined => {
      const resolved = resolve(node, bindings);
      if (!resolved || !closed(resolved.node)) return undefined;
      const type = checker.getTypeFromTypeNode(resolved.node);
      const keys: string[] = [];
      for (const part of type.isUnion() ? type.types : [type]) {
        if (!part.isStringLiteral() && !part.isNumberLiteral()) return undefined;
        keys.push(String(part.value));
      }
      return keys;
    };
    const nameOf = (element: ts.TypeElement | ts.ClassElement): string | undefined => {
      const name = element.name;
      return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
    };
    /**
     * The member types an index selects from a shape written out (a type literal, an interface or class of no
     * contract), with the bindings of that place; a selected method gives no type to look into. Undefined when the
     * keys are not known, or a key is no member the shape declares itself (inherited, an index signature).
     */
    const select = (node: ts.TypeNode, bindings: Bindings, keys: readonly string[] | undefined): Bound[] | undefined => {
      if (!keys) return undefined;
      const resolved = resolve(node, bindings);
      if (!resolved) return undefined;
      let shape: { elements: readonly (ts.TypeElement | ts.ClassElement)[]; bindings: Bindings } | undefined;
      if (ts.isTypeLiteralNode(resolved.node)) shape = { elements: resolved.node.members, bindings: resolved.bindings };
      else if (ts.isTypeReferenceNode(resolved.node)) {
        const named = target(resolved.node, resolved.bindings);
        if (named && !ts.isTypeAliasDeclaration(named.declaration) && declarationOf(named.declaration)?.kind !== "contract") shape = { elements: named.declaration.members, bindings: named.bindings };
      }
      if (!shape) return undefined;
      const values: Bound[] = [];
      for (const key of keys) {
        const elements = shape.elements.filter((element) => nameOf(element) === key);
        if (elements.length === 0) return undefined;
        for (const element of elements) {
          if ((ts.isPropertySignature(element) || ts.isPropertyDeclaration(element)) && element.type) values.push({ node: element.type, bindings: shape.bindings });
          else if (!(ts.isMethodSignature(element) || ts.isMethodDeclaration(element))) return undefined;
        }
      }
      return values;
    };
    /**
     * A shape indexed by keys that are not known: any member may be the one taken. If any of them copies a
     * contract, or holds an indexed access that may select one, which one is taken cannot be told.
     */
    const unselected = (site: ts.Node, elements: readonly (ts.TypeElement | ts.ClassElement)[], bindings: Bindings, depth: number) => {
      const before = found.length;
      members(elements, bindings, depth);
      let indexes = false;
      const visit = (child: ts.Node) => {
        if (indexes) return;
        indexes = ts.isIndexedAccessTypeNode(child);
        if (!indexes) ts.forEachChild(child, visit);
      };
      elements.forEach(visit);
      if (found.splice(before).length > 0 || indexes) found.push({ site, contract: undefined });
    };
    /**
     * Whether indexing an object hands on a contract's API, judged by what the object is with the arguments of
     * this place and by the members the keys select, when they are known: the compiler is asked only about a node
     * that means the same everywhere; an open one is taken apart, and what cannot be taken apart is reported as
     * unknown rather than taken as no contract's.
     */
    const fromObject = (site: ts.Node, node: ts.TypeNode, bindings: Bindings, depth: number, keys: readonly string[] | undefined): void => {
      if (exhausted(site, depth)) return;
      const resolved = resolve(node, bindings);
      if (!resolved) return void found.push({ site, contract: undefined });
      const { node: object, bindings: bound } = resolved;
      const asked = () => {
        const contract = contractBehind(checker.getTypeFromTypeNode(object));
        if (contract) found.push({ site, contract });
      };
      if (ts.isUnionTypeNode(object) || ts.isIntersectionTypeNode(object)) return object.types.forEach((part) => fromObject(site, part, bound, depth + 1, keys));
      if (ts.isConditionalTypeNode(object)) return conditional(object, bound, depth, (branch, at, next) => fromObject(site, branch, at, next, keys));
      // A shape written out: what the selected members are made of is what indexing it gives.
      if (ts.isTypeLiteralNode(object)) {
        const values = select(object, bound, keys);
        return values ? values.forEach((value) => member(value.node, value.bindings, depth + 1)) : unselected(site, object.members, bound, depth);
      }
      if (ts.isMappedTypeNode(object)) return member(object.type, bound, depth + 1);
      if (ts.isIndexedAccessTypeNode(object)) {
        // A member selected from a shape is the object the outer keys select from.
        const values = select(object.objectType, bound, keysOf(object.indexType, bound));
        if (values) return values.forEach((value) => fromObject(site, value.node, value.bindings, depth + 1, keys));
        if (closed(object)) asked();
        return fromObject(site, object.objectType, bound, depth + 1, keysOf(object.indexType, bound));
      }
      if (ts.isTypeReferenceNode(object)) {
        const named = target(object, bound);
        const design = named && declarationOf(named.declaration);
        if (design?.kind === "contract") {
          if (!exempt(design)) found.push({ site, contract: design });
          return;
        }
        if (!named || ts.isTypeAliasDeclaration(named.declaration)) return closed(object) ? asked() : void found.push({ site, contract: undefined });
        const values = select(object, bound, keys);
        if (values) return values.forEach((value) => member(value.node, value.bindings, depth + 1));
        // Keys not known, or not the shape's own: its members, its bases, and what the compiler says it inherits.
        const symbol = named.declaration.name && checker.getSymbolAtLocation(named.declaration.name);
        if (closed(object)) asked();
        else {
          const contract = symbol && contractBehind(checker.getDeclaredTypeOfSymbol(symbol));
          if (contract) found.push({ site, contract });
        }
        unselected(site, named.declaration.members, named.bindings, depth);
        for (const clause of named.declaration.heritageClauses ?? []) {
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) structure(type, named.bindings, depth + 1);
        }
        return;
      }
      if (closed(object)) return asked();
      found.push({ site, contract: undefined });
    };
    const indexed = (node: ts.IndexedAccessTypeNode, bindings: Bindings) => fromObject(node, node.objectType, bindings, 0, keysOf(node.indexType, bindings));
    /**
     * The branches of a conditional type that are taken. One that means the same everywhere is decided by the
     * compiler: the branch whose type is the result, the true one when the result is an instantiation of it (an
     * `infer` in it) and the false one is `never`, both when the result is neither (a distribution). One that
     * depends on the arguments of this place, or that the compiler defers, cannot be decided with its public API:
     * both branches are walked, and if either hands on anything the base is reported as unknown, never as a copy
     * from a branch that may not be taken.
     */
    const conditional = (node: ts.ConditionalTypeNode, bindings: Bindings, depth: number, walk: (branch: ts.TypeNode, bindings: Bindings, depth: number) => void) => {
      if (closed(node)) {
        const result = checker.getTypeFromTypeNode(node);
        if (!(result.flags & ts.TypeFlags.Conditional)) {
          const whenTrue = checker.getTypeFromTypeNode(node.trueType), whenFalse = checker.getTypeFromTypeNode(node.falseType);
          const taken = result === whenTrue ? [node.trueType] : result === whenFalse ? [node.falseType] : whenFalse.flags & ts.TypeFlags.Never ? [node.trueType] : [node.trueType, node.falseType];
          return taken.forEach((branch) => walk(branch, bindings, depth + 1));
        }
      }
      const before = found.length;
      [node.trueType, node.falseType].forEach((branch) => walk(branch, bindings, depth + 1));
      if (found.splice(before).length > 0) found.push({ site: node, contract: undefined });
    };
    /**
     * A type parameter no argument is given for, where a member or a base is made of it. A mapped type's key is
     * a key, no member's API; anything else (an `infer`) has an origin the walk cannot tell, which is reported.
     */
    const unbound = (node: ts.TypeReferenceNode, symbol: ts.Symbol) => {
      if (symbol.declarations?.some((declaration) => ts.isMappedTypeNode(declaration.parent))) return;
      found.push({ site: node, contract: undefined });
    };
    /** What a reference names: its declaration and the bindings of its parameters. */
    const target = (reference: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments, bindings: Bindings) => {
      const name = ts.isTypeReferenceNode(reference) ? reference.typeName : reference.expression;
      const symbol = resolveAlias(checker.getSymbolAtLocation(ts.isPropertyAccessExpression(name) ? name.name : name));
      const declaration = symbol?.declarations?.find((candidate) => ts.isTypeAliasDeclaration(candidate) || ts.isInterfaceDeclaration(candidate) || ts.isClassDeclaration(candidate));
      if (!declaration || !(ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))) return undefined;
      return { declaration, bindings: bind(declaration.typeParameters, reference.typeArguments, bindings) };
    };
    /** A member's type: copied from a contract when it is an indexed access on one, directly or through aliases. */
    const member = (node: ts.TypeNode | undefined, bindings: Bindings, depth: number): void => {
      if (!node || exhausted(node, depth)) return;
      if (ts.isParenthesizedTypeNode(node) || ts.isOptionalTypeNode(node) || ts.isRestTypeNode(node)) return member(node.type, bindings, depth + 1);
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.forEach((part) => member(part, bindings, depth + 1));
      if (ts.isConditionalTypeNode(node)) return conditional(node, bindings, depth, member);
      if (ts.isIndexedAccessTypeNode(node)) return void indexed(node, bindings);
      if (!ts.isTypeReferenceNode(node)) return;
      const symbol = checker.getSymbolAtLocation(node.typeName);
      if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) {
        const bound = bindings.get(symbol);
        return bound ? member(bound.node, bound.bindings, depth + 1) : unbound(node, symbol);
      }
      // An alias of a member type is followed; an interface or class is a type the field has, not a copy.
      const named = target(node, bindings);
      if (named && ts.isTypeAliasDeclaration(named.declaration)) member(named.declaration.type, named.bindings, depth + 1);
    };
    const members = (elements: readonly (ts.TypeElement | ts.ClassElement)[], bindings: Bindings, depth: number) => {
      for (const element of elements) {
        if ((ts.isPropertySignature(element) || ts.isPropertyDeclaration(element)) && element.type) member(element.type, bindings, depth + 1);
      }
    };
    /** The structure of a base: what its members are made of. */
    const structure = (node: ts.TypeNode | ts.ExpressionWithTypeArguments, bindings: Bindings, depth: number): void => {
      if (exhausted(node, depth)) return;
      if (ts.isParenthesizedTypeNode(node)) return structure(node.type, bindings, depth + 1);
      if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.forEach((part) => structure(part, bindings, depth + 1));
      if (ts.isConditionalTypeNode(node)) return conditional(node, bindings, depth, structure);
      if (ts.isIndexedAccessTypeNode(node)) return void indexed(node, bindings);
      if (ts.isTypeLiteralNode(node)) return members(node.members, bindings, depth);
      if (ts.isMappedTypeNode(node)) return member(node.type, bindings, depth + 1);
      if (!ts.isTypeReferenceNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      if (ts.isTypeReferenceNode(node)) {
        const symbol = checker.getSymbolAtLocation(node.typeName);
        if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter) {
          const bound = bindings.get(symbol);
          return bound ? structure(bound.node, bound.bindings, depth + 1) : unbound(node, symbol);
        }
      }
      const named = target(node, bindings);
      if (!named) return;
      const design = declarationOf(named.declaration);
      if (design?.kind === "contract") {
        if (!exempt(design)) found.push({ site: node, contract: design });
        return;
      }
      if (ts.isTypeAliasDeclaration(named.declaration)) return structure(named.declaration.type, named.bindings, depth + 1);
      members(named.declaration.members, named.bindings, depth);
      for (const clause of named.declaration.heritageClauses ?? []) {
        if (clause.token === ts.SyntaxKind.ExtendsKeyword) for (const type of clause.types) structure(type, named.bindings, depth + 1);
      }
    };
    structure(start, new Map(), 0);
    return found;
  };

  // What the contracts are before any of them takes what it inherits.
  const ownSource = new Map(index.contracts.map((contract) => [contract, contract.source]));
  const ownInvariants = new Map(index.contracts.map((contract) => [contract.name, index.invariants.filter((invariant) => invariant.contract === contract.name)]));
  const contractOf = (declaration: DesignDeclaration) => index.contracts.find((contract) => contract.module === declaration.module && contract.name === declaration.name);

  /** The design declarations above one, breadth first, each once: a diamond has its top once. */
  const ancestorsOf = (start: DesignDeclaration): DesignDeclaration[] => {
    const seen = new Set([keyOf(start)]);
    const found: DesignDeclaration[] = [];
    for (let queue = [start], next = queue.shift(); next; next = queue.shift()) {
      for (const type of heritageOf(next.node)) {
        const base = baseOf(type);
        if (!base || !("node" in base) || seen.has(keyOf(base))) continue;
        seen.add(keyOf(base));
        found.push(base);
        queue.push(base);
      }
    }
    return found;
  };

  for (const contract of index.contracts) {
    const design = designs.find((candidate) => candidate.moduleId === contract.module);
    const self = design && design.sourceFile.statements.map(declarationOf).find((found) => found?.kind === "contract" && found.name === contract.name);
    if (!self || !ts.isInterfaceDeclaration(self.node)) continue;
    const node = self.node;
    const written = heritageOf(node);
    if (written.length === 0) continue;
    const report = (code: string, message: string, at: SourceLocation, extra?: Partial<Diagnostic>) =>
      diagnostics.push({ code, severity: "error", message: `${contract.name}: ${message}`, ...at, contract: contract.name, ...extra });
    const locate = (target: ts.Node) => byFile.get(target.getSourceFile())!.locate(target.getStart());
    const failed = diagnostics.length;

    // Each base is a design's declaration or a package's; one named twice is one base.
    const bases: { base: Base; type: ts.ExpressionWithTypeArguments; members: Set<ts.__String> }[] = [];
    for (const type of written) {
      const base = baseOf(type);
      if (!base) {
        report("E_UNSUPPORTED_DECLARATION", `\`extends ${type.getText()}\`: a contract extends \`@contract\` or \`@data\` declarations of the designs, or the types of an imported package`, locate(type));
      } else if (!bases.some((known) => keyOf(known.base) === keyOf(base))) {
        bases.push({ base, type, members: new Set(checker.getPropertiesOfType(checker.getTypeFromTypeNode(type)).map((property) => property.escapedName)) });
      }
    }
    if (diagnostics.length > failed) continue;
    contract.bases = bases.map(({ base: { name, module, kind } }) => ({ name, module, kind }));
    for (const { base, type } of bases) {
      if ((base.kind !== "package" && base.kind !== "project")) index.edges.push({ kind: "extends", from: contract.name, to: base.name, toKind: base.kind, fromModule: contract.module, toModule: base.module, location: locate(type) });
    }

    // The effective API is the compiler's: it has merged the bases with the body and rejected what conflicts.
    const type = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(node.name)!);
    const isOwn = (declaration: ts.Node) => declaration.parent === node;
    const unsupported = (what: string) => report("E_UNSUPPORTED_DECLARATION", what, contract.location);
    // The exact comparison of an implementation has nothing to hold an open or a constructible contract to.
    if (checker.getIndexInfosOfType(type).length > 0) unsupported("inherits an index signature, which leaves the contract open: an implementation cannot be compared with it exactly");
    if (checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length > 0) unsupported("inherits a construct signature: an implementation cannot be compared with it exactly");

    // The invariants of a contract come with its API only along `extends`: a `@data` alias that picks or
    // intersects a contract would hand on its members and leave its promises behind.
    const ancestors = ancestorsOf(self);
    const behind = (declaration: ts.Node | undefined) => {
      const owner = declaration && ownerOf(declaration);
      return owner?.kind === "contract" && keyOf(owner) !== keyOf(self) && !ancestors.some((ancestor) => keyOf(ancestor) === keyOf(owner)) ? owner : undefined;
    };
    // A copy of a contract's API that keeps no declaration of it (`Record`, a mapping by key, `Writer["write"]`) is
    // found in the base's structure. One written in a design is reported where it is written; what the declarations
    // below show is reported at the contract, for a copy made inside a library type such as `Pick`.
    const extractions = bases.filter(({ base }) => base.kind !== "contract").flatMap(({ type: written }) => extractionsOf(written, self, ancestors).map((extraction) => ({ ...extraction, written })));
    const authoredCopy = (extraction: { site: ts.Node }) => byFile.has(extraction.site.getSourceFile());
    const reported = new Set(extractions.filter((extraction) => extraction.contract && authoredCopy(extraction)).map((extraction) => keyOf(extraction.contract!)));
    let refused = false;
    const left = (what: string, owner: DesignDeclaration) => {
      refused = true;
      if (reported.has(keyOf(owner))) return;
      reported.add(keyOf(owner));
      unsupported(`inherits ${what} of contract "${owner.name}" without extending it; extend "${owner.name}" so that its invariants come along`);
    };

    const members: ContractMember[] = [...contract.members];
    const signatures = new Map<string, string>();
    /** A signature as the lock records it: as declared, and resolved where a generic declaration was instantiated. */
    const recorded = (declarations: readonly ts.Node[], resolved: () => string, effective = false) =>
      [...declarations.map((declaration) => print(declaration)), ...(effective || declarations.some(generic) ? [`as ${resolved()}`] : [])].join(" ");
    /**
     * What a member is in the contract, where that may differ from its declaration: a mapped type (`Readonly`,
     * `Partial`, `-readonly`, `Pick`) makes an ordinary field of it with its own modifiers, an instantiation its own
     * type. The resolved type, and each modifier the declaration does not already say, as the exact comparison of
     * implementations sees them; `null` for a member that is its declaration unchanged.
     */
    const effectiveOf = (property: ts.Symbol, declarations: readonly ts.Declaration[]): string | null => {
      const name = declarations.map((declaration) => ts.getNameOfDeclaration(declaration)).find((candidate) => candidate !== undefined);
      const declared = name && checker.getSymbolAtLocation(name);
      if (declared === property && !declarations.some(generic)) return null;
      const modifiers = (declaration: ts.Declaration) => (ts.canHaveModifiers(declaration) ? (ts.getModifiers(declaration) ?? []) : []);
      const wasReadonly =
        declarations.some((declaration) => modifiers(declaration).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) ||
        (declarations.some(ts.isGetAccessorDeclaration) && !declarations.some(ts.isSetAccessorDeclaration));
      const wasOptional = declarations.some((declaration) => (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) || ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration)) && declaration.questionToken !== undefined);
      const readonly = shape.readonly(property, type);
      const optional = shape.optional(property);
      const flags = [
        ...(readonly === undefined ? ["readonly-unresolved"] : readonly !== wasReadonly ? [readonly ? "readonly" : "mutable"] : []),
        ...(optional !== wasOptional ? [optional ? "optional" : "required"] : []),
        // An accessor a mapped type turned into a field is a field: one type to read and to write.
        ...(declarations.some((declaration) => ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration)) && declared !== property ? ["field"] : []),
      ];
      return [...flags, checker.typeToString(checker.getTypeOfSymbolAtLocation(property, node), node, ts.TypeFormatFlags.NoTruncation)].join(" ");
    };
    for (const property of checker.getPropertiesOfType(type)) {
      const declarations = property.declarations ?? [];
      // A member the body declares, also one it redeclares, is the contract's own; private and protected ones are no public API.
      if (declarations.some(isOwn) || hidden(property)) continue;
      const authored = declarations.find((declaration) => byFile.has(declaration.getSourceFile()));
      const owner = behind(authored);
      if (owner) {
        left(`"${property.name}"`, owner);
        continue;
      }
      const via = bases.find((base) => base.members.has(property.escapedName)) ?? bases[0];
      const declaredIn = authored && ownerOf(authored);
      const from = declaredIn ?? via.base;
      const description = declaredIn?.kind === "contract" ? (contractOf(declaredIn)?.members.find((member) => member.name === property.name)?.description ?? null) : null;
      const name = property.name.startsWith("__@") ? checker.symbolToString(property) : property.name;
      // Declared outside the designs (a package, a library type), a member is where the design brings it in.
      members.push({ name, description, location: authored ? locate(authored) : locate(via.type), inheritedFrom: { name: from.name, module: from.module, kind: from.kind } });

      // Keyed as the lock keys a member it declares itself: by its name as written.
      const written = declarations.map((declaration) => ts.getNameOfDeclaration(declaration)).find((candidate) => candidate !== undefined);
      const key = written ? print(written) : /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
      const resolvedType = () => checker.typeToString(checker.getTypeOfSymbolAtLocation(property, node), node, ts.TypeFormatFlags.NoTruncation);
      const effective = declarations.length > 0 ? effectiveOf(property, declarations) : null;
      signatures.set(
        key,
        declarations.length > 0
          ? recorded(declarations, () => effective ?? resolvedType(), effective !== null)
          : `${shape.readonly(property, type) ? "readonly " : ""}${key}${shape.optional(property) ? "?" : ""}: ${resolvedType()}`,
      );
    }
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call).filter((call) => {
      const declaration = call.getDeclaration();
      return declaration === undefined || !isOwn(declaration);
    });
    for (const call of calls) {
      const owner = behind(call.getDeclaration());
      if (owner) left("a call signature", owner);
    }
    const seen = new Set<ts.Node>();
    for (const extraction of extractions) {
      const { site, contract: from, written } = extraction;
      if (seen.has(site)) continue;
      seen.add(site);
      const at = authoredCopy(extraction) ? locate(site) : locate(written);
      if (!from) {
        report("E_UNSUPPORTED_DECLARATION", `\`extends ${written.getText()}\`: where a member of this base comes from cannot be told, so it cannot be told whether a contract's invariants are left behind`, at);
      } else if (authoredCopy(extraction) || !reported.has(keyOf(from))) {
        reported.add(keyOf(from));
        report("E_UNSUPPORTED_DECLARATION", `\`extends ${written.getText()}\` copies the API of contract "${from.name}" without extending it; extend "${from.name}" so that its invariants come along`, at);
      }
    }
    const ownCall = node.members.some(ts.isCallSignatureDeclaration);
    if (members.length === 0 && calls.length === 0 && !ownCall && !refused && !contract.family) unsupported("a contract needs at least one member or a call signature");
    if (diagnostics.length > failed) continue;
    contract.members = members;
    if (calls.length > 0) contract.shape = "callable";

    // Invariants: those of every base contract up the chain, with where they were declared. One id has one origin.
    const declared = new Map<string, Invariant>(ownInvariants.get(contract.name)!.map((invariant) => [invariant.id, invariant]));
    const inherited: Invariant[] = [];
    for (const ancestor of ancestors) {
      if (ancestor.kind !== "contract") continue;
      for (const invariant of ownInvariants.get(ancestor.name) ?? []) {
        const first = declared.get(invariant.id);
        if (first) {
          const from = (candidate: Invariant) => (candidate.inheritedFrom ? `inherited from "${candidate.inheritedFrom.contract}"` : `declared by "${contract.name}"`);
          report("E_INVARIANT_DUPLICATE", `${contract.name}.${invariant.id} ${from(first)} and inherited from "${ancestor.name}"`, first.inheritedFrom ? contract.location : first.location, {
            invariant: invariant.id,
            related: [{ message: "the other invariant", ...invariant.location }, ...(first.inheritedFrom ? [{ message: "the first invariant", ...first.location }] : [])],
          });
          continue;
        }
        const copy: Invariant = { contract: contract.name, id: invariant.id, text: invariant.text, member: invariant.member, inheritedFrom: { contract: ancestor.name, module: ancestor.module }, location: invariant.location };
        declared.set(invariant.id, copy);
        inherited.push(copy);
      }
    }
    if (diagnostics.length > failed) continue;
    index.invariants.push(...inherited);
    if (declared.size === 0) diagnostics.push({ code: "W_NO_INVARIANTS", severity: "warning", message: contract.name, ...contract.location, contract: contract.name });

    // Review: an edit to a design base is an edit to the contract, however far up the chain it is and in whichever module.
    const baseSources = ancestors.map((ancestor) => {
      const base = ancestor.kind === "contract" ? contractOf(ancestor) : undefined;
      return base ? ownSource.get(base)! : ancestor.node.getFullText(ancestor.design.sourceFile).trim();
    });
    contract.source = [ownSource.get(contract)!, ...baseSources].join("\n\n");

    // Lock: an inherited signature or invariant is part of what the lock holds, as if it were written here.
    const locked = index.locked.find((candidate) => candidate.kind === "contract" && candidate.module === contract.module && candidate.name === contract.name);
    if (locked) {
      // Built from entries, so that a member called `__proto__` or `toString` is an ordinary key.
      const entries = new Map(Object.entries(locked.members));
      for (const [key, signature] of signatures) entries.set(key, signature);
      const inheritedCalls = calls.map((call) => {
        const declaration = call.getDeclaration();
        return declaration ? recorded([declaration], () => checker.signatureToString(call, node, ts.TypeFormatFlags.NoTruncation)) : checker.signatureToString(call, node, ts.TypeFormatFlags.NoTruncation);
      });
      if (inheritedCalls.length > 0) entries.set(":call", [...(entries.has(":call") ? [entries.get(":call")!] : []), ...inheritedCalls].join(" "));
      locked.members = Object.fromEntries(entries);
      locked.invariants = Object.fromEntries([...Object.entries(locked.invariants), ...inherited.map((invariant) => [invariant.id, invariant.text.replace(/\s+/g, " ")])]);
    }
  }
  return diagnostics;
}
