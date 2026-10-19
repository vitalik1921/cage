import type ts from "typescript";
import type { TypeScript } from "./typescript.ts";

/** Public API comparison, independent of method bivariance and permissive excess-property assignment. */
export function shapeChecker(ts: TypeScript, checker: ts.TypeChecker) {
  let steps = 0, limited = false;
  type Substitutions = { left: Map<ts.Type, ts.Type>; right: Map<ts.Type, ts.Type> };
  // A universal pair claims `target<X> ≡ other` for every X on `side`; it is proved with the parameters opaque.
  type Universal = { side: "left" | "right"; target: ts.Type; other: ts.Type };
  type Pair = { a: ts.Type; b: ts.Type; substitutions: Substitutions; universal?: Universal };
  const emptySubstitutions = (): Substitutions => ({ left: new Map(), right: new Map() });
  const sameMap = (a: ReadonlyMap<ts.Type, ts.Type>, b: ReadonlyMap<ts.Type, ts.Type>) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
  const sameSubstitutions = (a: Substitutions, b: Substitutions) => sameMap(a.left, b.left) && sameMap(a.right, b.right);
  const resolve = (type: ts.Type, substitutions: ReadonlyMap<ts.Type, ts.Type>) => {
    const seen = new Set<ts.Type>();
    while (substitutions.has(type) && !seen.has(type)) { seen.add(type); type = substitutions.get(type)!; }
    return type;
  };
  const hidden = (symbol: ts.Symbol): boolean => !!symbol.declarations?.length && symbol.declarations.every(node =>
    ((ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && ts.isPrivateIdentifier(node.name)) ||
    (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword)));
  const properties = (type: ts.Type) => checker.getPropertiesOfType(type).filter(symbol => !hidden(symbol));
  const readonly = (symbol: ts.Symbol, owner: ts.Type, seen = new Set<ts.Type>()): boolean | undefined => {
    if (seen.has(owner)) return undefined;
    seen = new Set(seen).add(owner);
    if (owner.isUnionOrIntersection()) {
      const parts = owner.types.flatMap(type => {
        const member = checker.getPropertyOfType(type, symbol.name);
        return member ? [readonly(member, type, seen)] : [];
      });
      // An intersection permits a write provided by either constituent; a union must permit it in every arm.
      if (parts.includes(owner.isUnion())) return owner.isUnion();
      return parts.length && !parts.includes(undefined) ? owner.isIntersection() : undefined;
    }
    if (owner.isClassOrInterface()) {
      for (const base of checker.getBaseTypes(owner)) {
        const inherited = checker.getPropertyOfType(base, symbol.name);
        if (inherited?.declarations?.some(d => symbol.declarations?.includes(d))) return readonly(inherited, base, seen);
      }
    }
    const mapped = owner.getSymbol()?.declarations?.find(ts.isMappedTypeNode);
    if (mapped) {
      const resolved = resolvedReadonly(symbol, owner);
      if (resolved !== undefined) return resolved;
      if (mapped.readonlyToken) return mapped.readonlyToken.kind !== ts.SyntaxKind.MinusToken;
      // The modifiers come, as the checker takes them, from X of a written `keyof X` constraint, else of a
      // `keyof X` the constraint (or the constraint type parameter's constraint) resolves to; failing both there are none.
      const constraint = mapped.typeParameter.constraint;
      let source: ts.Type;
      if (constraint && ts.isTypeOperatorNode(constraint) && constraint.operator === ts.SyntaxKind.KeyOfKeyword) source = checker.getTypeFromTypeNode(constraint.type);
      else {
        const declared = constraint && checker.getTypeFromTypeNode(constraint);
        const bound = declared && declared.flags & ts.TypeFlags.TypeParameter ? declared.getSymbol()?.declarations?.find(ts.isTypeParameterDeclaration)?.constraint : undefined;
        const keys = bound ? checker.getTypeFromTypeNode(bound) : declared;
        if (!keys || !(keys.flags & ts.TypeFlags.Index)) return false;
        source = (keys as ts.IndexType).type;
        if (!(source.flags & ts.TypeFlags.TypeParameter)) return undefined;
      }
      if (source.flags & ts.TypeFlags.TypeParameter) {
        const parameter = source;
        const alias = owner.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
        const index = alias?.typeParameters?.findIndex(p => checker.getTypeAtLocation(p) === parameter) ?? -1;
        const argument = owner.aliasTypeArguments?.[index] ?? mappedInstance(owner)?.arguments.get(parameter);
        if (!argument) return undefined;
        source = argument;
      }
      const originalName = symbol.declarations?.[0];
      const name = originalName && (ts.isPropertySignature(originalName) || ts.isMethodSignature(originalName)) && ts.isIdentifier(originalName.name) ? originalName.name.text : symbol.name;
      const original = checker.getPropertyOfType(source, name);
      return original ? readonly(original, source, seen) : undefined;
    }
    const declarations = symbol.declarations ?? [];
    // A const assertion supplies readonly without a modifier on the property's declaration.
    for (const declaration of [...declarations, ...(owner.getSymbol()?.declarations?.filter(ts.isObjectLiteralExpression) ?? [])]) {
      let node: ts.Node = declaration;
      while (node.parent && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node) || ts.isParenthesizedExpression(node))) {
        node = node.parent;
        if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
          if (ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName) && node.type.typeName.text === "const") return true;
        }
      }
    }
    return declarations.some(node => ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword)) ||
      (declarations.some(ts.isGetAccessorDeclaration) && !declarations.some(node => ts.isSetAccessorDeclaration(node) && !hiddenNode(node)));
  };
  // The modifiers type of an instantiated mapped type (keyof T, K extends keyof T, nested helpers) is not in the
  // public API, but declaration emit spells a resolved one member by member with the checker's own readonly.
  // A generic mapped type is emitted as a mapped type node and stays undecided here.
  const emitted = new Map<ts.Type, ts.TypeNode | undefined>();
  const emit = (type: ts.Type) => {
    if (!emitted.has(type)) emitted.set(type, checker.typeToTypeNode(type, undefined, ts.NodeBuilderFlags.InTypeAlias | ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.IgnoreErrors));
    return emitted.get(type);
  };
  const resolvedReadonly = (symbol: ts.Symbol, owner: ts.Type): boolean | undefined => {
    const node = emit(owner);
    const members = node && ts.isTypeLiteralNode(node) ? node.members.filter(m => m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name) || ts.isNumericLiteral(m.name)) &&
      ts.escapeLeadingUnderscores(m.name.text) === symbol.escapedName) : undefined;
    if (members?.length !== 1 || !ts.isPropertySignature(members[0])) return undefined;
    return !!ts.getModifiers(members[0])?.some(m => m.kind === ts.SyntaxKind.ReadonlyKeyword);
  };
  const hiddenNode = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword);
  // A mapped member over literal keys ([K in "a"]) has no declaration: its type needs no location.
  const typeOf = (symbol: ts.Symbol, fallback: ts.Node | undefined) => {
    const location = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? fallback;
    return location ? checker.getTypeOfSymbolAtLocation(symbol, location) : checker.getTypeOfSymbol(symbol);
  };
  const optional = (symbol: ts.Symbol) => !!(symbol.flags & ts.SymbolFlags.Optional);
  // Without strictNullChecks undefined belongs to every type and never appears in a union.
  const strictNull = !checker.isTypeAssignableTo(checker.getUndefinedType(), checker.getNumberType());
  const hasUndefined = (type: ts.Type) => !!(type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || (type.isUnion() && type.types.some(t => !!(t.flags & ts.TypeFlags.Undefined)));
  const withoutUndefined = (type: ts.Type) => type.isUnion() ? type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined)) : type.flags & ts.TypeFlags.Undefined ? [] : [type];
  const sameParts = (a: ts.Type[], b: ts.Type[], eq: (x: ts.Type, y: ts.Type) => boolean) => {
    if (a.length !== b.length) return false;
    const remaining = [...b];
    return a.every(x => { const index = remaining.findIndex(y => eq(x, y)); if (index < 0) return false; remaining.splice(index, 1); return true; });
  };
  // The caller's view: a parameter with an initializer accepts undefined, although its symbol carries the
  // body's type without it; it is optional only when no required parameter follows (`a = 1, b: number`).
  const parameterShape = (symbol: ts.Symbol, node: ts.Node) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    const type = typeOf(symbol, node);
    if (!declaration || !ts.isParameter(declaration)) return { optional: optional(symbol), rest: false, type, undefined: hasUndefined(type) };
    const rest = !!declaration.dotDotDotToken;
    return {
      optional: !rest && checker.isOptionalParameter(declaration), rest, type,
      undefined: hasUndefined(type) || (!rest && strictNull && !!(declaration.questionToken || declaration.initializer)),
    };
  };
  const generic = (type: ts.Type) => {
    if ((type.flags & ts.TypeFlags.Object) && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) {
      const reference = type as ts.TypeReference;
      return { target: reference.target, parameters: reference.target.typeParameters ?? [], arguments: checker.getTypeArguments(reference) };
    }
    const alias = type.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration);
    if (alias?.typeParameters?.length) return { target: checker.getDeclaredTypeOfSymbol(type.aliasSymbol!), parameters: alias.typeParameters.map(p => checker.getTypeAtLocation(p)), arguments: type.aliasTypeArguments ?? [] };
    return undefined;
  };
  // Instances of one mapped type declaration (flatten<T> = identity<{[k in keyof T]: T[k]}>) carry no alias or
  // type arguments. An argument is read back only where the instance is the template's own instantiation:
  // - a member that is required and has no `?` modifier holds the template instance itself, so a type parameter
  //   there, or an argument of a class, interface or object-alias reference there, is exactly the argument;
  // - in a generic instance an indexed access of the homomorphic source (X of `keyof X`) by the member's key is
  //   deferred, so its object is the argument (reduced); optionality only adds undefined-flagged members beside it.
  // Nothing else is inferred, nothing is stripped from an argument, and an outer type parameter the declaration
  // names that is not recovered, or recovered as two different types, leaves the instance without arguments.
  const instances = new Map<ts.Type, { node: ts.MappedTypeNode; arguments: Map<ts.Type, ts.Type> } | undefined>();
  const withinNode = (node: ts.Node, container: ts.Node) => { for (let n: ts.Node | undefined = node; n; n = n.parent) if (n === container) return true; return false; };
  // The type parameters declared outside `node` that it can depend on: those it names. Undefined where it can depend
  // on more: `this`, typeof through values, local aliases of an enclosing block.
  const namedParameters = (node: ts.Node): Set<ts.Type> | undefined => {
    if ((function local(n: ts.Node | undefined): boolean { return !!n && (ts.isBlock(n) || local(n.parent)); })(node.parent)) return undefined;
    const outer = new Set<ts.Type>();
    let open = false;
    const scan = (n: ts.Node): void => {
      if (ts.isTypeQueryNode(n) || n.kind === ts.SyntaxKind.ThisType) open = true;
      else if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
        const symbol = checker.getSymbolAtLocation(n.typeName);
        if (symbol && symbol.flags & ts.SymbolFlags.TypeParameter && !symbol.declarations?.every(d => withinNode(d, node))) outer.add(checker.getDeclaredTypeOfSymbol(symbol));
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
    return open ? undefined : outer;
  };
  const mappedInstance = (type: ts.Type) => {
    if (!instances.has(type)) instances.set(type, recoverInstance(type));
    return instances.get(type);
  };
  const recoverInstance = (type: ts.Type) => {
    const node = type.flags & ts.TypeFlags.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped ? type.getSymbol()?.declarations?.find(ts.isMappedTypeNode) : undefined;
    if (!node || !node.type) return undefined;
    const parameterOf = (n: ts.TypeNode) => {
      const symbol = ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) ? checker.getSymbolAtLocation(n.typeName) : undefined;
      return symbol && symbol.flags & ts.SymbolFlags.TypeParameter ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
    };
    const outer = namedParameters(node);
    if (!outer) return undefined;
    const key = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(node.typeParameter.name)!);
    const constraint = node.typeParameter.constraint;
    const source = constraint && ts.isTypeOperatorNode(constraint) && constraint.operator === ts.SyntaxKind.KeyOfKeyword ? parameterOf(constraint.type) : undefined;
    // A generic mapped instance is emitted as a mapped type node; a resolved one member by member.
    const deferred = !!source && outer.has(source) && (() => { const emittedNode = emit(type); return !!emittedNode && ts.isMappedTypeNode(emittedNode); })();
    const found = new Map<ts.Type, ts.Type>();
    let conflict = false;
    const bind = (parameter: ts.Type, argument: ts.Type) => {
      if (found.has(parameter) && found.get(parameter) !== argument) conflict = true;
      found.set(parameter, argument);
    };
    // `t` is exactly the instance of `n`.
    const exact = (n: ts.TypeNode, t: ts.Type): void => {
      if (ts.isParenthesizedTypeNode(n)) return exact(n.type, t);
      if (ts.isIndexedAccessTypeNode(n)) return access(n, t);
      if (!ts.isTypeReferenceNode(n) || !ts.isIdentifier(n.typeName)) return;
      const parameter = parameterOf(n);
      if (parameter) { if (outer.has(parameter)) bind(parameter, t); return; }
      const symbol = checker.getSymbolAtLocation(n.typeName);
      const written = n.typeArguments ?? [];
      if (!symbol || !written.length) return;
      const reference = t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? t as ts.TypeReference : undefined;
      if (reference && symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) && reference.target === checker.getDeclaredTypeOfSymbol(symbol)) {
        const actual = checker.getTypeArguments(reference);
        written.forEach((w, i) => { if (actual[i]) exact(w, actual[i]); });
        return;
      }
      // Only an object-literal or mapped alias body instantiates to a new type carrying exactly these arguments.
      const alias = symbol.declarations?.find(ts.isTypeAliasDeclaration);
      if (alias && t.aliasSymbol === symbol && (ts.isTypeLiteralNode(alias.type) || ts.isMappedTypeNode(alias.type))) {
        written.forEach((w, i) => { const actual = t.aliasTypeArguments?.[i]; if (actual) exact(w, actual); });
      }
    };
    // `t` is the instance of an indexed access chain rooted at the source by the member's key: X[k], X[k]["_output"].
    const access = (n: ts.IndexedAccessTypeNode, t: ts.Type, member?: string): void => {
      if (!deferred || !(t.flags & ts.TypeFlags.IndexedAccess)) return;
      const { objectType, indexType } = t as ts.IndexedAccessType;
      const object = ts.isParenthesizedTypeNode(n.objectType) ? n.objectType.type : n.objectType;
      if (parameterOf(n.indexType) === key) {
        if (parameterOf(object) !== source || !member || !indexType.isStringLiteral() || indexType.value !== member) return;
        bind(source!, objectType);
      } else if (ts.isLiteralTypeNode(n.indexType) && indexType === checker.getTypeFromTypeNode(n.indexType) && ts.isIndexedAccessTypeNode(object)) access(object, objectType, member);
    };
    for (const property of checker.getPropertiesOfType(type)) {
      const value = checker.getTypeOfSymbol(property);
      const template = ts.isParenthesizedTypeNode(node.type) ? node.type.type : node.type;
      if (ts.isIndexedAccessTypeNode(template)) {
        // Optionality adds undefined (or the missing type) beside the deferred access; the access itself is kept whole.
        const parts = value.isUnion() ? value.types.filter(t => !(t.flags & ts.TypeFlags.Undefined)) : [value];
        if (parts.length === 1) access(template, parts[0], property.name);
      } else if (!(property.flags & ts.SymbolFlags.Optional) && !node.questionToken) exact(template, value);
    }
    if (conflict || [...outer].some(p => !found.has(p))) return undefined;
    return { node, arguments: found };
  };
  // Mapped members are ordinary fields, even when their source declarations were accessors;
  // a union or intersection decides per constituent, since it has no mapped declaration of its own.
  const liveSetter = (symbol: ts.Symbol, owner: ts.Type, seen = new Set<ts.Type>()): ts.SetAccessorDeclaration | undefined => {
    if (seen.has(owner)) return undefined;
    seen = new Set(seen).add(owner);
    if (owner.isUnionOrIntersection()) {
      for (const type of owner.types) {
        const member = checker.getPropertyOfType(type, symbol.name);
        const setter = member && liveSetter(member, type, seen);
        if (setter) return setter;
      }
      return undefined;
    }
    if (owner.getSymbol()?.declarations?.some(ts.isMappedTypeNode)) return undefined;
    // An inherited member is a field or a setter as its base declares it (interface I extends Id<C>);
    // a member the type redeclares has declarations of its own and keeps them.
    const declaring = owner.isClassOrInterface() ? owner : generic(owner)?.target;
    if (declaring?.isClassOrInterface()) {
      for (const base of checker.getBaseTypes(declaring)) {
        const inherited = checker.getPropertyOfType(base, symbol.name);
        if (inherited?.declarations?.some(d => symbol.declarations?.includes(d))) return liveSetter(inherited, base, seen);
      }
    }
    return symbol.declarations?.find((d): d is ts.SetAccessorDeclaration => ts.isSetAccessorDeclaration(d) && !hiddenNode(d));
  };
  const writeType = (symbol: ts.Symbol, owner: ts.Type, fallback: ts.Node | undefined) => {
    const setter = liveSetter(symbol, owner);
    if (!setter) return { type: typeOf(symbol, fallback), parameters: new Map<ts.Type, ts.Type>() };
    const parameters = new Map<ts.Type, ts.Type>();
    const seen = new Set<ts.Type>();
    const visit = (type: ts.Type) => {
      if (seen.has(type)) return;
      seen.add(type);
      const g = generic(type);
      g?.parameters.forEach((p, i) => { if (g.arguments[i] && p !== g.arguments[i]) parameters.set(p, g.arguments[i]); });
      if (type.isUnionOrIntersection()) type.types.forEach(visit);
      const baseOwner = type.isClassOrInterface() ? type : g?.target;
      if (baseOwner?.isClassOrInterface()) checker.getBaseTypes(baseOwner).forEach(visit);
    };
    visit(owner);
    return { type: checker.getTypeAtLocation(setter.parameters[0]), parameters };
  };
  // A method's instantiated signatures substitute its owner's type parameters (class and base arguments) invisibly;
  // its declared constraints still name them (refine<R extends Output>). The owner's references and declared bases
  // spell that substitution. Only a member's own method declarations use it; a parameter bound twice is left out.
  // It proves equal constraints only as the same declaration over equal arguments; it never substitutes into one.
  type OwnerScope = { declarations: readonly ts.Declaration[]; parameters: Map<ts.Type, ts.Type> };
  const ownerScopes = new WeakMap<ts.Type, OwnerScope>();
  const ownerParameters = (owner: ts.Type) => {
    const parameters = new Map<ts.Type, ts.Type>(), ambiguous = new Set<ts.Type>(), seen = new Set<ts.Type>();
    const visit = (type: ts.Type) => {
      if (seen.has(type)) return;
      seen.add(type);
      const g = generic(type);
      g?.parameters.forEach((p, i) => {
        const argument = g.arguments[i];
        if (!argument || p === argument) return;
        if (parameters.has(p) && parameters.get(p) !== argument) ambiguous.add(p);
        parameters.set(p, argument);
      });
      if (type.isUnionOrIntersection()) type.types.forEach(visit);
      const baseOwner = type.isClassOrInterface() ? type : g?.target;
      if (baseOwner?.isClassOrInterface()) checker.getBaseTypes(baseOwner).forEach(visit);
    };
    visit(owner);
    for (const p of ambiguous) parameters.delete(p);
    return parameters;
  };
  // A combined member's declarations merge every constituent's setter, so the first setter and one shared
  // substitution map cannot describe it: each constituent contributes its own write type and substitutions.
  type Write = { type: ts.Type; parameters: Map<ts.Type, ts.Type> };
  const writeTypes = (symbol: ts.Symbol, owner: ts.Type, fallback: ts.Node | undefined, seen = new Set<ts.Type>()): Write[] => {
    if (!owner.isUnionOrIntersection() || seen.has(owner)) return [writeType(symbol, owner, fallback)];
    seen = new Set(seen).add(owner);
    return owner.types.flatMap(type => {
      const part = checker.getPropertyOfType(type, symbol.name);
      return part ? writeTypes(part, type, fallback, seen) : [];
    });
  };
  // Under a universal claim, a type whose members could depend on an opaque parameter other than by
  // plain substitution, or that is itself not a closed shape, cannot be compared: the proof gives up.
  const opaque = (type: ts.Type): boolean => {
    if (type.flags & ts.TypeFlags.Instantiable) return true;
    if (type.isIntersection()) return type.types.some(opaque);
    if (!(type.flags & ts.TypeFlags.Object)) return false;
    if ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) return true;
    return checker.isTupleType(type) && (type as ts.TupleTypeReference).target.elementFlags.some(flag => flag & ts.ElementFlags.Variadic);
  };
  const failedUniversals: Universal[] = [];
  // A generic that grows on one side against the same other type (Branch<T> -> Branch<T[]> against Tree)
  // never repeats a pair. Prove instead that every instantiation equals the other type: compare the declared
  // generic, with its parameters opaque, assuming the claim for every instantiation reached on the way.
  // A step that inspects an opaque parameter fails the proof, so a success holds for any substitution.
  // The claim is used only below the first expansion of the declared generic, never to approve it outright.
  function universal(a: ts.Type, b: ts.Type, active: readonly Pair[], parameters: Substitutions): boolean {
    for (const side of ["left", "right"] as const) {
      const [grown, other] = side === "left" ? [a, b] : [b, a];
      const g = generic(grown);
      if (!g?.parameters.length) continue;
      const map = side === "left" ? parameters.left : parameters.right;
      const repeated = active.some(pair => {
        const [earlier, against] = side === "left" ? [pair.a, pair.b] : [pair.b, pair.a];
        return !pair.universal && against === other && earlier !== grown && generic(earlier)?.target === g.target && sameSubstitutions(pair.substitutions, parameters);
      });
      if (!repeated || failedUniversals.some(u => u.side === side && u.target === g.target && u.other === other)) continue;
      // Substituted parameters are not opaque; the same parameters opaque on both sides would be equated by identity.
      const self = g.target.isClassOrInterface() ? g.target.thisType : undefined;
      if ([...g.parameters, ...(self ? [self] : [])].some(p => map.has(p)) || active.some(pair => pair.universal?.target === g.target && pair.universal.side !== side)) continue;
      const claim: Universal = { side, target: g.target, other };
      const [x, y] = side === "left" ? [g.target, other] : [other, g.target];
      if (!opaque(x) && !opaque(y) && structural(x, y, [...active, { a: x, b: y, substitutions: parameters, universal: claim }], parameters)) return true;
      failedUniversals.push(claim);
    }
    return false;
  }
  /** Undefined-flagged constituents of an optional tuple element: undefined itself, another marker, both or none. */
  const undefinedMarkers = (type: ts.Type) => {
    const parts = (type.isUnion() ? type.types : [type]).filter(part => part.flags & ts.TypeFlags.Undefined);
    return `${parts.some(part => part === checker.getUndefinedType())}/${parts.some(part => part !== checker.getUndefinedType())}`;
  };
  const deferred = ts.TypeFlags.Instantiable & ~ts.TypeFlags.TypeParameter;
  const operator = ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping;
  // The type parameters a type mentions; undefined where an object or conditional may hide some.
  const mentions = (type: ts.Type, seen = new Set<ts.Type>()): ts.Type[] | undefined => {
    if (seen.has(type)) return [];
    seen.add(type);
    const all = (types: readonly ts.Type[]) => {
      const found: ts.Type[] = [];
      for (const part of types) { const inner = mentions(part, seen); if (!inner) return undefined; found.push(...inner); }
      return found;
    };
    const F = ts.TypeFlags;
    if (type.flags & F.TypeParameter) return [type];
    if (type.isUnionOrIntersection()) return all(type.types);
    if (type.flags & F.Index) return all([(type as ts.IndexType).type]);
    if (type.flags & F.IndexedAccess) return all([(type as ts.IndexedAccessType).objectType, (type as ts.IndexedAccessType).indexType]);
    if (type.flags & F.TemplateLiteral) return all((type as ts.TemplateLiteralType).types);
    if (type.flags & F.StringMapping) return all([(type as ts.StringMappingType).type]);
    if (type.flags & F.Substitution) return all([(type as ts.SubstitutionType).baseType, (type as ts.SubstitutionType).constraint]);
    if ((type.flags & F.Object) && ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return all(checker.getTypeArguments(type as ts.TypeReference));
    return type.flags & (F.Object | F.Conditional) ? undefined : [];
  };
  // A raw type means itself when none of the parameters it mentions is substituted on its side.
  const closed = (type: ts.Type, map: ReadonlyMap<ts.Type, ts.Type>) => !map.size || !!mentions(type)?.every(p => !map.has(p));
  // keyof of a substituted object type: its public literal keys. Index signatures, mapped types,
  // symbol-like and numeric-like keys are not evaluated. Other types count when they are primitive unions.
  const keyAtoms = (type: ts.Type, map: ReadonlyMap<ts.Type, ts.Type>): ts.Type[] | undefined => {
    if (!(type.flags & ts.TypeFlags.Instantiable)) return closed(type, map) ? primitiveMembers(type) : undefined;
    if (!(type.flags & ts.TypeFlags.Index)) return undefined;
    const source = resolve((type as ts.IndexType).type, map);
    if (!(source.flags & ts.TypeFlags.Object) || ((source as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) || checker.getIndexInfosOfType(source).length) return undefined;
    const names = properties(source).map(p => p.escapedName as string);
    if (names.some(name => name.startsWith("__") || String(Number(name)) === name)) return undefined;
    return names.map(name => checker.getStringLiteralType(name));
  };
  // Each comparison owns its cycle set: an unsuccessful union candidate must not approve another path.
  function equal(a: ts.Type, b: ts.Type, active: readonly Pair[] = [], parameters: Substitutions = emptySubstitutions()): boolean {
    // Some recursive instantiations grow forever (Branch<T[]> against a non-generic tree).
    // Failing to establish equality must become an explicit diagnostic, never a crash or a pass.
    if (++steps > 10000 || active.length > 64) { limited = true; return false; }
    a = resolve(a, parameters.left); b = resolve(b, parameters.right);
    // One deferred type under different substitutions (keyof T with T={a} and T={b}) is not one type.
    if (a === b && (sameMap(parameters.left, parameters.right) || (!(a.flags & (ts.TypeFlags.Object | deferred)) && !a.isUnionOrIntersection()))) return true;
    if ((a.flags & ts.TypeFlags.Any) || (b.flags & ts.TypeFlags.Any)) return !!(a.flags & ts.TypeFlags.Any) && !!(b.flags & ts.TypeFlags.Any);
    if (active.some(pair => !pair.universal && pair.a === a && pair.b === b && sameSubstitutions(pair.substitutions, parameters))) return true;
    const claims = active.flatMap(pair => pair.universal ? [{ claim: pair.universal, substitutions: pair.substitutions }] : []);
    if (claims.some(({ claim, substitutions }) => sameSubstitutions(substitutions, parameters) &&
      (claim.side === "left" ? b === claim.other && generic(a)?.target === claim.target : a === claim.other && generic(b)?.target === claim.target))) return true;
    if (claims.length && (opaque(a) || opaque(b))) return false;
    if (universal(a, b, active, parameters)) return true;
    return structural(a, b, [...active, { a, b, substitutions: parameters }], parameters);
  }
  // An interface that declares nothing and extends one base (interface Schema extends ZodObject<…> {}) has exactly
  // the base's members, signatures and index signatures, with itself as `this`: coinductively it is the base.
  const soleBase = (type: ts.Type) => {
    const symbol = type.getSymbol();
    if (!type.isClassOrInterface() || type.typeParameters?.length || !symbol || symbol.flags & ts.SymbolFlags.Class || !(symbol.flags & ts.SymbolFlags.Interface)) return undefined;
    const declarations = symbol.declarations?.filter(ts.isInterfaceDeclaration) ?? [];
    if (!declarations.length || declarations.some(d => d.members.length)) return undefined;
    const bases = checker.getBaseTypes(type);
    return bases.length === 1 ? bases[0] : undefined;
  };
  function structural(a: ts.Type, b: ts.Type, next: readonly Pair[], parameters: Substitutions): boolean {
    const eq = (x: ts.Type, y: ts.Type) => equal(x, y, next, parameters);
    const baseA = soleBase(a), baseB = soleBase(b);
    if (baseA || baseB) return eq(baseA ?? a, baseB ?? b);
    // Compare instantiations through their arguments, without unfolding recursive library methods
    // such as Array.map -> Array.map -> ... . The shared target already fixes the member declarations.
    // Element labels give each tuple its own target; compare the structure, ignoring labels.
    if (checker.isTupleType(a) || checker.isTupleType(b)) {
      if (!checker.isTupleType(a) || !checker.isTupleType(b)) return false;
      const at = (a as ts.TupleTypeReference).target, bt = (b as ts.TupleTypeReference).target;
      const count = at.elementFlags.length;
      if (at.readonly !== bt.readonly || count !== bt.elementFlags.length || at.elementFlags.some((flag, i) => flag !== bt.elementFlags[i])) return false;
      const ae = checker.getTypeArguments(a as ts.TupleTypeReference), be = checker.getTypeArguments(b as ts.TupleTypeReference);
      for (let i = 0; i < count; i++) if (!ae[i] || !be[i] || !eq(ae[i], be[i])) return false;
      // With exactOptionalPropertyTypes an optional element carries an undefined-flagged "missing" marker
      // instead of undefined itself; assignability equates the two, but only the latter accepts a written undefined.
      const optionalAt = at.elementFlags.flatMap((flag, i) => flag & ts.ElementFlags.Optional ? [i] : []);
      if (optionalAt.some(i => undefinedMarkers(ae[i]) !== undefinedMarkers(be[i]))) return false;
      // Without substitutions the compiler can confirm the tuples themselves; disagreement is unproved, not equal.
      if (optionalAt.length && !parameters.left.size && !parameters.right.size && !next.some(pair => pair.universal) &&
        !(checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a))) { limited = true; return false; }
      return true;
    }
    const ag = generic(a), bg = generic(b);
    if (ag && bg && ag.target === bg.target) {
      if (ag.arguments.length === bg.arguments.length && ag.arguments.every((t, i) => eq(t, bg.arguments[i]))) return true;
    }
    // The same mapped declaration with equal arguments is the same type, as for references above.
    const am = mappedInstance(a), bm = mappedInstance(b);
    if (am && bm && am.node === bm.node && [...am.arguments].every(([p, t]) => eq(t, bm.arguments.get(p)!))) return true;
    // Mapping one declaration's parameters onto another's would substitute an opaque parameter.
    if (!next.some(pair => pair.universal) && ag && bg && ag.parameters.length > 0 && ag.parameters.length === bg.parameters.length && (a !== ag.target || b !== bg.target)) {
      const mapped = { left: new Map(parameters.left), right: parameters.right }; ag.parameters.forEach((p, i) => mapped.left.set(p, bg.parameters[i]));
      if (ag.arguments.length === bg.arguments.length && equal(ag.target, bg.target, next, mapped) && ag.arguments.every((t, i) => eq(t, bg.arguments[i]))) return true;
    }
    if ((a.flags & ts.TypeFlags.Conditional) || (b.flags & ts.TypeFlags.Conditional)) {
      if (!(a.flags & ts.TypeFlags.Conditional) || !(b.flags & ts.TypeFlags.Conditional)) return false;
      return conditional(a as ts.ConditionalType, b as ts.ConditionalType, next, parameters);
    }
    // Inside a true branch the checker narrows the check type to a substitution (T & Extends).
    if ((a.flags & ts.TypeFlags.Substitution) || (b.flags & ts.TypeFlags.Substitution)) {
      if (!(a.flags & ts.TypeFlags.Substitution) || !(b.flags & ts.TypeFlags.Substitution)) return false;
      const x = a as ts.SubstitutionType, y = b as ts.SubstitutionType;
      return eq(x.baseType, y.baseType) && eq(x.constraint, y.constraint);
    }
    // Deferred operators: the same operator over equal operands, evaluated keys, or raw types that mean
    // themselves. Otherwise a substituted operand leaves the result unknown: never approved, never refuted.
    if ((a.flags | b.flags) & operator) {
      if (sameOperator(a, b, eq)) return true;
      const ak = keyAtoms(a, parameters.left), bk = keyAtoms(b, parameters.right);
      if (ak && bk) return within(ak, bk) && within(bk, ak);
      if (closed(a, parameters.left) && closed(b, parameters.right)) return !object(a) && !object(b) && checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
      limited = true; return false;
    }
    if (a.isUnion() || b.isUnion()) {
      if (!a.isUnion() || !b.isUnion() || a.types.length !== b.types.length) return false;
      const remaining = [...b.types];
      return a.types.every(x => { const index = remaining.findIndex(y => eq(x, y)); if (index < 0) return false; remaining.splice(index, 1); return true; });
    }
    // An intersection with a substituted parameter has no members of its own to compare: compare its parts.
    if ([a, b].some(t => t.isIntersection() && t.types.some(part => part.flags & ts.TypeFlags.Instantiable))) {
      if (a.isIntersection() && b.isIntersection() && sameParts(a.types, b.types, eq)) return true;
      if (!closed(a, parameters.left) || !closed(b, parameters.right)) { limited = true; return false; }
    }
    if (!object(a) || !object(b)) return !object(a) && !object(b) && checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a);
    const ap = properties(a), bp = properties(b);
    if (ap.length !== bp.length) return false;
    for (const x of ap) {
      const y = bp.find(p => p.escapedName === x.escapedName);
      const node = x.valueDeclaration ?? x.declarations?.[0] ?? y?.valueDeclaration ?? y?.declarations?.[0];
      if (!y || !member(x, a, y, b, node, next, parameters)) return false;
    }
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      const as = checker.getSignaturesOfType(a, kind), bs = checker.getSignaturesOfType(b, kind);
      if (as.length !== bs.length || as.some((s, i) => !signature(s, bs[i], next, parameters, [owned(s, a), owned(bs[i], b)]))) return false;
    }
    const ai = checker.getIndexInfosOfType(a), bi = checker.getIndexInfosOfType(b);
    return ai.length === bi.length && ai.every(x => bi.some(y => x.isReadonly === y.isReadonly && eq(x.keyType, y.keyType) && eq(x.type, y.type)));
  }
  const object = (t: ts.Type) => !!(t.flags & ts.TypeFlags.Object) || t.isIntersection();
  const within = (xs: readonly ts.Type[], ys: readonly ts.Type[]) => xs.every(x => ys.some(y => checker.isTypeAssignableTo(x, y)));
  function sameOperator(a: ts.Type, b: ts.Type, eq: (x: ts.Type, y: ts.Type) => boolean): boolean {
    const F = ts.TypeFlags, kind = a.flags & operator;
    if (!kind || kind !== (b.flags & operator)) return false;
    if (kind & F.Index) return eq((a as ts.IndexType).type, (b as ts.IndexType).type);
    if (kind & F.IndexedAccess) {
      const x = a as ts.IndexedAccessType, y = b as ts.IndexedAccessType;
      return eq(x.objectType, y.objectType) && eq(x.indexType, y.indexType);
    }
    if (kind & F.StringMapping) return (a as ts.StringMappingType).symbol === (b as ts.StringMappingType).symbol && eq((a as ts.StringMappingType).type, (b as ts.StringMappingType).type);
    const x = a as ts.TemplateLiteralType, y = b as ts.TemplateLiteralType;
    return x.texts.length === y.texts.length && x.texts.every((text, i) => text === y.texts[i]) && x.types.every((t, i) => eq(t, y.types[i]));
  }
  // A type parameter's constraint as declared (B extends A, B extends keyof A); the base constraint would erase
  // it to A's base. Unconstrained means unknown. Where the declaration was instantiated, a substitution of an
  // outer parameter is invisible here: a constraint naming any parameter outside `own` is then undefined (uncheckable).
  const declaredConstraint = (p: ts.Type, own?: ReadonlySet<ts.Type>): ts.Type | undefined => {
    const declaration = p.symbol?.declarations?.find(ts.isTypeParameterDeclaration);
    if (!declaration) return checker.getBaseConstraintOfType(p) ?? checker.getUnknownType();
    const node = ts.getEffectiveConstraintOfTypeParameter(declaration);
    const type = node ? checker.getTypeFromTypeNode(node) : checker.getUnknownType();
    // An object type may hide parameters from the type; the written constraint names every one it can depend on.
    const named = mentions(type) ?? (node && namedParameters(node));
    return !own || (named && [...named].every(q => own.has(q))) ? type : undefined;
  };
  function sameConstraints(at: readonly ts.Type[], bt: readonly ts.Type[], scope: Substitutions, active: readonly Pair[], ownA?: ReadonlySet<ts.Type>, ownB?: ReadonlySet<ts.Type>, sameDeclaration?: (i: number) => boolean): boolean {
    for (let i = 0; i < at.length; i++) {
      const x = declaredConstraint(at[i], ownA), y = declaredConstraint(bt[i], ownB);
      if (!x || !y) { if (sameDeclaration?.(i)) continue; limited = true; return false; }
      if (!equal(x, y, active, scope)) return false;
    }
    return true;
  }
  // An instantiated signature's parameters are clones; its declared constraints name the originals.
  const clones = (ps: readonly ts.Type[]) => new Map(ps.flatMap(p => {
    const original = p.symbol && checker.getDeclaredTypeOfSymbol(p.symbol);
    return original && original !== p ? [[original, p] as const] : [];
  }));
  // A deferred conditional is compared part by part: check, extends, branches and distributivity.
  // Its infer type parameters are bound pairwise, in scope for the extends type and the true branch only.
  const branches = (type: ts.ConditionalType) => {
    // The checker resolves instantiated branches lazily; a constraint query resolves both.
    if (!type.resolvedTrueType || !type.resolvedFalseType) checker.getBaseConstraintOfType(type);
    if (type.resolvedTrueType && type.resolvedFalseType) return { whenTrue: type.resolvedTrueType, whenFalse: type.resolvedFalseType };
    const { root } = type;
    if (type.checkType !== root.checkType || type.extendsType !== root.extendsType) return undefined;
    return { whenTrue: checker.getTypeFromTypeNode(root.node.trueType), whenFalse: checker.getTypeFromTypeNode(root.node.falseType) };
  };
  function conditional(a: ts.ConditionalType, b: ts.ConditionalType, active: readonly Pair[], outer: Substitutions): boolean {
    if (a.root.isDistributive !== b.root.isDistributive) return false;
    const ai = a.root.inferTypeParameters ?? [], bi = b.root.inferTypeParameters ?? [];
    if (ai.length !== bi.length) return false;
    const ab = branches(a), bb = branches(b);
    if (!ab || !bb) { limited = true; return false; }
    const inner = { left: new Map(outer.left), right: outer.right }; ai.forEach((p, i) => inner.left.set(p, bi[i]));
    const eq = (x: ts.Type, y: ts.Type, scope: Substitutions) => equal(x, y, active, scope);
    // Root infer parameters are originals; in an instantiated conditional their constraints may name substituted outer parameters.
    const own = (type: ts.ConditionalType, ps: readonly ts.Type[]) => type.checkType === type.root.checkType && type.extendsType === type.root.extendsType ? undefined : new Set(ps);
    if (!sameConstraints(ai, bi, inner, active, own(a, ai), own(b, bi))) return false;
    return eq(a.checkType, b.checkType, outer) && eq(a.extendsType, b.extendsType, inner) &&
      eq(ab.whenTrue, bb.whenTrue, inner) && eq(ab.whenFalse, bb.whenFalse, outer);
  }
  function member(a: ts.Symbol, ownerA: ts.Type, b: ts.Symbol, ownerB: ts.Type, node: ts.Node | undefined, active: readonly Pair[] = [], parameters: Substitutions = emptySubstitutions()): boolean {
    const ar = readonly(a, ownerA), br = readonly(b, ownerB);
    if (ar === undefined || br === undefined) { limited = true; return false; }
    const at = typeOf(a, node), bt = typeOf(b, node);
    if (a.declarations?.length && !ownerScopes.has(at)) ownerScopes.set(at, { declarations: a.declarations, parameters: ownerParameters(ownerA) });
    if (b.declarations?.length && !ownerScopes.has(bt)) ownerScopes.set(bt, { declarations: b.declarations, parameters: ownerParameters(ownerB) });
    // As for tuple elements: with exactOptionalPropertyTypes `a?: string` holds the missing marker, `a?: string | undefined`
    // undefined itself; assignability equates the two, but only the latter accepts a written undefined.
    if (optional(a) !== optional(b) || ar !== br || (optional(a) && undefinedMarkers(at) !== undefinedMarkers(bt)) || !equal(at, bt, active, parameters)) return false;
    if (ar || ![...(a.declarations ?? []), ...(b.declarations ?? [])].some(ts.isSetAccessorDeclaration)) return true;
    // The effective input is the intersection of all constituent inputs (string & (string|number) = string).
    const ad = inputDomain(writeTypes(a, ownerA, node), parameters.left, active), bd = inputDomain(writeTypes(b, ownerB, node), parameters.right, active);
    if (ad && "write" in ad && bd && "write" in bd) {
      return equal(ad.write.type, bd.write.type, active, { left: new Map([...parameters.left, ...ad.write.parameters]), right: new Map([...parameters.right, ...bd.write.parameters]) });
    }
    const aa = ad && atoms(ad, parameters.left), ba = bd && atoms(bd, parameters.right);
    if (!aa || !ba) { limited = true; return false; }
    return within(aa, ba) && within(ba, aa);
  }
  // A union of primitives and literals: its members are pairwise nested or disjoint, so assignability decides
  // intersections member by member. Anything else (objects, type parameters, branded primitives) is not composed.
  const primitiveMembers = (type: ts.Type) => {
    const F = ts.TypeFlags, primitive = F.String | F.Number | F.BigInt | F.Boolean | F.ESSymbol | F.UniqueESSymbol | F.Void | F.Undefined | F.Null |
      F.StringLiteral | F.NumberLiteral | F.BigIntLiteral | F.BooleanLiteral | F.Never;
    const members = type.isUnion() ? type.types : [type];
    return members.every(t => t.flags & primitive) ? members.filter(t => !(t.flags & ts.TypeFlags.Never)) : undefined;
  };
  type Domain = { write: Write } | { atoms: ts.Type[] };
  /** The input domain shared by all constituents; undefined where it cannot be composed safely. */
  function inputDomain(writes: readonly Write[], outer: ReadonlyMap<ts.Type, ts.Type>, active: readonly Pair[]): Domain | undefined {
    const scoped = (w: Write) => new Map([...outer, ...w.parameters]);
    // Equivalent inputs keep their own substitutions and are compared exactly, generic or not.
    const distinct: Write[] = [];
    for (const w of writes) if (!distinct.some(d => equal(d.type, w.type, active, { left: scoped(d), right: scoped(w) }))) distinct.push(w);
    if (distinct.length === 1) return { write: distinct[0] };
    const resolved = distinct.map(w => resolve(w.type, scoped(w)));
    const members = resolved.map(primitiveMembers);
    if (!distinct.length || members.some(m => !m)) return undefined;
    // One input contained in all others is the domain itself.
    const narrowest = resolved.findIndex(t => resolved.every(u => checker.isTypeAssignableTo(t, u)));
    if (narrowest >= 0) return { write: distinct[narrowest] };
    return { atoms: [...new Set(members.flatMap(m => m!).filter(m => resolved.every(u => checker.isTypeAssignableTo(m, u))))] };
  }
  function atoms(domain: Domain, outer: ReadonlyMap<ts.Type, ts.Type>) {
    return "atoms" in domain ? domain.atoms : primitiveMembers(resolve(domain.write.type, new Map([...outer, ...domain.write.parameters])));
  }
  // The owner substitution of a signature that is the declaration of the member whose type carries it.
  const owned = (s: ts.Signature, type: ts.Type) => {
    const scope = ownerScopes.get(type), declaration = s.getDeclaration();
    return scope && declaration && scope.declarations.includes(declaration) ? scope.parameters : undefined;
  };
  function signature(a: ts.Signature, b: ts.Signature, active: readonly Pair[] = [], outer: Substitutions = emptySubstitutions(), owners: readonly [ReadonlyMap<ts.Type, ts.Type> | undefined, ReadonlyMap<ts.Type, ts.Type> | undefined] = [undefined, undefined]): boolean {
    const ap = a.getParameters(), bp = b.getParameters();
    const at = a.typeParameters ?? [], bt = b.typeParameters ?? [];
    if (ap.length !== bp.length || at.length !== bt.length || !!a.thisParameter !== !!b.thisParameter) return false;
    const parameters = { left: new Map(outer.left), right: outer.right }; at.forEach((p, i) => parameters.left.set(p, bt[i]));
    const eq = (x: ts.Type, y: ts.Type) => equal(x, y, active, parameters);
    const ac = clones(at), bc = clones(bt);
    const scope = { left: new Map([...parameters.left, ...ac]), right: new Map([...parameters.right, ...bc]) };
    // A constraint naming the owner's parameters: one written constraint, instantiated with equal owner arguments
    // on both sides (its own parameters correspond pairwise), is one constraint. Unequal or unbound stays unchecked.
    const [oa, ob] = owners;
    const sameDeclaration = (i: number) => {
      const declaration = at[i].symbol?.declarations?.find(ts.isTypeParameterDeclaration);
      const node = declaration && ts.getEffectiveConstraintOfTypeParameter(declaration);
      const named = node && declaration === bt[i].symbol?.declarations?.find(ts.isTypeParameterDeclaration) ? namedParameters(node) : undefined;
      if (!named || !oa || !ob) return false;
      return [...named].every(p => {
        if (ac.has(p) && bc.has(p)) return true;
        const x = oa.get(p), y = ob.get(p);
        return !!x && !!y && equal(x, y, active, outer);
      });
    };
    if (!sameConstraints(at, bt, scope, active, ac.size ? new Set(ac.keys()) : undefined, bc.size ? new Set(bc.keys()) : undefined, sameDeclaration)) return false;
    for (let i = 0; i < at.length; i++) {
      const x = checker.getDefaultFromTypeParameter(at[i]), y = checker.getDefaultFromTypeParameter(bt[i]); if (x && y ? !eq(x, y) : x !== y) return false;
    }
    const node = a.getDeclaration() ?? b.getDeclaration();
    if (!node) return false;
    if (a.thisParameter && b.thisParameter && !eq(typeOf(a.thisParameter, node), typeOf(b.thisParameter, node))) return false;
    for (let i = 0; i < ap.length; i++) {
      const x = parameterShape(ap[i], node), y = parameterShape(bp[i], node);
      if (x.optional !== y.optional || x.rest !== y.rest || x.undefined !== y.undefined) return false;
      if (hasUndefined(x.type) === hasUndefined(y.type) ? !eq(x.type, y.type) : !sameParts(withoutUndefined(x.type), withoutUndefined(y.type), eq)) return false;
    }
    const ar = checker.getTypePredicateOfSignature(a), br = checker.getTypePredicateOfSignature(b);
    if (!!ar !== !!br || (ar && br && (ar.kind !== br.kind || ("parameterIndex" in ar && "parameterIndex" in br && ar.parameterIndex !== br.parameterIndex) || (ar.type && br.type ? !eq(ar.type, br.type) : ar.type !== br.type)))) return false;
    return eq(checker.getReturnTypeOfSignature(a), checker.getReturnTypeOfSignature(b));
  }
  // A proven equality stands, whatever an abandoned alternative (another union member) could not decide.
  const compare = (fn: () => boolean): boolean => { steps = 0; limited = false; failedUniversals.length = 0; const same = fn(); if (same) limited = false; return same; };
  return {
    properties, readonly, optional, typeOf, writeType,
    member: (a: ts.Symbol, ownerA: ts.Type, b: ts.Symbol, ownerB: ts.Type, node: ts.Node) => compare(() => member(a, ownerA, b, ownerB, node)),
    equal: (a: ts.Type, b: ts.Type) => compare(() => equal(a, b)),
    signature: (a: ts.Signature, b: ts.Signature) => compare(() => signature(a, b)),
    get limited() { return limited; },
  };
}
