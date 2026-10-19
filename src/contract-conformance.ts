import type ts from "typescript";
import type { Contract, Implementation } from "./design-model.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { shapeChecker } from "./contract-shape.ts";
import type { TypeScript } from "./typescript.ts";

export interface ShapeBinding {
  implementation: Implementation;
  contract: Contract;
  actual: ts.Type;
  expected: ts.Type;
  node: ts.Node;
  declaration: ts.ClassDeclaration | undefined;
}

/** Exact public surface of every tagged declaration, against its single instance or static contract. */
export function checkContractSurfaces(ts: TypeScript, checker: ts.TypeChecker, bindings: ShapeBinding[]): Diagnostic[] {
  const shape = shapeChecker(ts, checker), causes = causeFinder(ts, checker, shape), diagnostics: Diagnostic[] = [];
  const assignable = new Set(bindings.filter(b => b.implementation.compatible));
  const groups = new Map<string, ShapeBinding[]>();
  for (const binding of bindings) {
    const key = `${binding.implementation.location.file}#${binding.implementation.name}`;
    groups.set(key, [...(groups.get(key) ?? []), binding]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const report = (code: string, message: string, affected: ShapeBinding[], node?: ts.Node, found?: Found, subject = first.implementation.name) => {
      const binding = affected[0] ?? first;
      let location = binding.implementation.location;
      // A member declared elsewhere (including a base class) is explained in the message; keep the diagnostic on the tagged declaration.
      if (node && node.getSourceFile() === first.declaration?.getSourceFile()) {
        const position = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
        location = { ...location, line: position.line + 1, column: position.character + 1 };
      }
      // Without a binding (for example, undeclared static API), retain the explanation of the missing surface.
      diagnostics.push({ code, severity: "error", message, ...location, contract: binding.contract.name, related: affected.map(b => ({ message: "contract", ...b.contract.location })), ...(found && affected.length > 0 ? { cause: { ...found, subject, contracts: affected.map(b => b.contract.name) } } : {}) });
      for (const b of affected.length ? affected : group) b.implementation.compatible = false;
    };
    const classNode = first.declaration;
    const symbol = classNode?.name ? checker.getSymbolAtLocation(classNode.name) : undefined;
    const sides = classNode ? [undefined, "static"] as const : [undefined];
    for (const side of sides) {
      const selected = group.filter(b => b.implementation.surface === side);
      const actual = selected[0]?.actual ?? (symbol ? side === "static" ? checker.getTypeOfSymbolAtLocation(symbol, classNode!) : checker.getDeclaredTypeOfSymbol(symbol) : first.actual);
      const label = `${first.implementation.name}${side ? " static" : ""}`;
      if (actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Union)) {
        report("E_CONTRACT_UNCHECKABLE", `${label}: public surface is not a concrete type`, selected);
        continue;
      }
      const expectedNames = new Set(selected.flatMap(b => shape.properties(b.expected).map(p => p.escapedName)));
      const actualMembers = shape.properties(actual).filter(p => !(side === "static" && p.name === "prototype"));
      for (const member of actualMembers) if (!expectedNames.has(member.escapedName)) {
        report("E_CONTRACT_EXTRA_MEMBER", `${label}.${member.name}: public member is absent from ${selected.length ? selected.map(b => b.contract.name).join(", ") : `the ${side ?? "instance"} contracts`}`, selected, member.valueDeclaration ?? member.declarations?.[0], causes.inherited(member, classNode), `${label}.${member.name}`);
      }
      if (checker.getIndexInfosOfType(actual).length) report("E_CONTRACT_UNCHECKABLE", `${label}: an index signature leaves the public surface open`, selected);
      const binding = selected[0];
      // Let ordinary compiler diagnostics explain missing required members and incompatible types.
      if (binding && selected.every(b => assignable.has(b))) {
        const expected = binding.expected;
        for (const expectedMember of shape.properties(expected)) {
          const affected = selected.filter(b => shape.properties(b.expected).some(p => p.escapedName === expectedMember.escapedName));
          const member = actualMembers.find(p => p.escapedName === expectedMember.escapedName);
          if (!member) {
            report("E_CONTRACT_MISSING_MEMBER", `${label}.${expectedMember.name}: declared member is absent`, affected);
            continue;
          }
          const actualType = shape.typeOf(member, binding.node), expectedType = shape.typeOf(expectedMember, binding.node);
          const sameType = shape.member(member, actual, expectedMember, expected, binding.node);
          if (shape.limited) {
            report("E_CONTRACT_UNCHECKABLE", `${label}.${member.name}: public type or setter domain cannot be resolved, or a recursive type exceeds the exact comparison limit`, affected);
          } else if (!sameType) {
            const describe = (p: ts.Symbol, owner: ts.Type, type: ts.Type) => `${shape.readonly(p, owner) ? "readonly " : ""}${p.name}${shape.optional(p) ? "?" : ""}: ${checker.typeToString(type)}${p.declarations?.some(ts.isSetAccessorDeclaration) ? `; writes: ${checker.typeToString(shape.writeType(p, owner, binding.node).type)}` : ""}`;
            report("E_CONTRACT_SIGNATURE", `${label}.${member.name}: signature differs from ${affected.map(b => b.contract.name).join(", ")}\nexpected: ${describe(expectedMember, expected, expectedType)}\nactual: ${describe(member, actual, actualType)}\nParameter count, optional/rest markers, readonly, setter inputs and nested public types must match.`, affected, member.valueDeclaration ?? member.declarations?.[0], causes.member(expectedMember, expected, expectedType, member, actual, actualType), `${label}.${member.name}`);
          }
        }
        const actualCalls = checker.getSignaturesOfType(actual, ts.SignatureKind.Call), expectedCalls = checker.getSignaturesOfType(expected, ts.SignatureKind.Call);
        let callLimited = false;
        const sameCalls = actualCalls.length === expectedCalls.length && actualCalls.every((call, i) => { const same = shape.signature(call, expectedCalls[i]); callLimited ||= shape.limited; return same; });
        if (!sameCalls) report(callLimited ? "E_CONTRACT_UNCHECKABLE" : "E_CONTRACT_SIGNATURE", callLimited ? `${label}: recursive call signature exceeds the exact comparison limit` : `${label}: call signature differs from ${selected.map(b => b.contract.name).join(", ")}; parameter count, optional/rest markers and types must match`, selected, undefined, callLimited ? undefined : causes.calls(expected, actual), label);
      }
    }
  }
  return diagnostics;
}


/** A cause without its subject: what the diagnostics that share it have in common. */
type Found = { id: string; summary: string };
/** A type as declarations: equal keys within one run are the same type; `owned` when a declaration outside the default library takes part. */
type Named = { key: string; name: string; owned: boolean };

/**
 * Causes shared by surface diagnostics, proved from declarations and the exact comparison, never from printed text:
 * - a signature whose only differences, at every differing parameter or return position, are one pair of types known
 *   by identity (declarations with the same arguments; a written alias counts by its own declaration), where at
 *   least one side names a declaration of the project or a package: a primitive or anonymous mismatch has no shared root;
 * - extra members that all come from one class or interface declaration other than the tagged class.
 * Anything else (overloads, generics, markers, parameter types, several pairs) has no cause.
 */
function causeFinder(ts: TypeScript, checker: ts.TypeChecker, shape: ReturnType<typeof shapeChecker>) {
  const ids = new Map<ts.Node | ts.Type, number>();
  const idOf = (identity: ts.Node | ts.Type) => {
    if (!ids.has(identity)) ids.set(identity, ids.size + 1);
    return `d${ids.get(identity)}`;
  };
  const declaration = (symbol: ts.Symbol | undefined) => symbol?.declarations?.[0];
  const owned = (node: ts.Node) => !node.getSourceFile().hasNoDefaultLib;
  const clip = (text: string) => text.length <= 120 ? text : `${text.slice(0, 119)}…`;
  const compose = (node: ts.Node | undefined, name: string, args: (Named | undefined)[]): Named | undefined => {
    if (!node || args.some(a => !a)) return undefined;
    const list = args as Named[];
    return {
      key: list.length ? `${idOf(node)}<${list.map(a => a.key).join(",")}>` : idOf(node),
      name: list.length ? `${name}<${list.map(a => a.name).join(", ")}>` : name,
      owned: owned(node) || list.some(a => a.owned),
    };
  };
  const F = ts.TypeFlags;
  // Intrinsic and literal types are unique per checker: the type itself is the identity.
  const intrinsic = F.Any | F.Unknown | F.String | F.Number | F.BigInt | F.ESSymbol | F.Void | F.Undefined | F.Null | F.Never | F.StringLiteral | F.NumberLiteral | F.BigIntLiteral | F.BooleanLiteral | F.Boolean;
  const named = (type: ts.Type, node: ts.TypeNode | undefined, depth = 0): Named | undefined => {
    if (depth > 4) return undefined;
    while (node && ts.isParenthesizedTypeNode(node)) node = node.type;
    if (node && ts.isTypeReferenceNode(node)) {
      // An alias of an intrinsic (type PageHandle = unknown) leaves no trace on the type: its written name does.
      let symbol = checker.getSymbolAtLocation(node.typeName);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      if (symbol && symbol.flags & ts.SymbolFlags.TypeAlias) return compose(declaration(symbol), symbol.name, (node.typeArguments ?? []).map(a => named(checker.getTypeFromTypeNode(a), a, depth + 1)));
    }
    if (type.aliasSymbol) return compose(declaration(type.aliasSymbol), type.aliasSymbol.name, (type.aliasTypeArguments ?? []).map(a => named(a, undefined, depth + 1)));
    if (type.flags & F.EnumLiteral) return compose(declaration(type.getSymbol()), checker.typeToString(type), []);
    if (type.flags & intrinsic) return { key: idOf(type), name: checker.typeToString(type), owned: false };
    if (checker.isTupleType(type)) {
      const target = (type as ts.TupleTypeReference).target;
      const args = checker.getTypeArguments(type as ts.TupleTypeReference).map(a => named(a, undefined, depth + 1));
      if (args.some(a => !a)) return undefined;
      // Element names do not take part in the comparison: the target's flags and readonly do.
      return { key: `tuple:${target.readonly}:${target.elementFlags.join(",")}<${(args as Named[]).map(a => a.key).join(",")}>`, name: checker.typeToString(type), owned: (args as Named[]).some(a => a.owned) };
    }
    if (type.flags & F.Object && (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
      const target = (type as ts.TypeReference).target;
      if (!target.isClassOrInterface() || target.outerTypeParameters?.length) return undefined;
      const result = compose(declaration(target.getSymbol()), "", checker.getTypeArguments(type as ts.TypeReference).slice(0, target.typeParameters?.length ?? 0).map(a => named(a, undefined, depth + 1)));
      return result && { ...result, name: checker.typeToString(type) };
    }
    if (type.isClassOrInterface()) return compose(declaration(type.getSymbol()), checker.typeToString(type), []);
    if (type.isUnion()) {
      const parts = type.types.map(t => named(t, undefined, depth + 1));
      if (parts.some(p => !p)) return undefined;
      return { key: `union(${(parts as Named[]).map(p => p.key).sort().join("|")})`, name: checker.typeToString(type), owned: (parts as Named[]).some(p => p.owned) };
    }
    return undefined;
  };
  // A name with what it stands for, as the checker prints the type behind it: Band = readonly [min: number, max: number].
  const shown = (name: string, type: ts.Type) => {
    const resolved = checker.typeToString(type, undefined, ts.TypeFormatFlags.InTypeAlias);
    return resolved === name ? clip(name) : `${clip(name)} = ${clip(resolved)}`;
  };
  type Difference = { expected: ts.Type; expectedNode?: ts.TypeNode; actual: ts.Type; actualNode?: ts.TypeNode };
  // The positions where two single signatures differ, when everything else is proved equal; undefined when not decidable.
  const differences = (expected: ts.Signature, actual: ts.Signature): Difference[] | undefined => {
    if (expected.typeParameters?.length || actual.typeParameters?.length || expected.thisParameter || actual.thisParameter) return undefined;
    if (checker.getTypePredicateOfSignature(expected) || checker.getTypePredicateOfSignature(actual)) return undefined;
    const ep = expected.getParameters(), ap = actual.getParameters();
    if (ep.length !== ap.length) return undefined;
    const found: Difference[] = [];
    for (let i = 0; i < ep.length; i++) {
      const ed = ep[i].valueDeclaration, ad = ap[i].valueDeclaration;
      if (!ed || !ad || !ts.isParameter(ed) || !ts.isParameter(ad)) return undefined;
      if (!!ed.dotDotDotToken !== !!ad.dotDotDotToken || checker.isOptionalParameter(ed) !== checker.isOptionalParameter(ad)) return undefined;
      const et = shape.typeOf(ep[i], ed), at = shape.typeOf(ap[i], ad);
      const same = shape.equal(et, at);
      if (shape.limited) return undefined;
      if (same) continue;
      // Optional and defaulted parameters add undefined beside the written type; leave them to the full message.
      if ([ed, ad].some(d => d.questionToken || d.initializer || d.dotDotDotToken)) return undefined;
      found.push({ expected: et, expectedNode: ed.type, actual: at, actualNode: ad.type });
    }
    const er = checker.getReturnTypeOfSignature(expected), ar = checker.getReturnTypeOfSignature(actual);
    const same = shape.equal(er, ar);
    if (shape.limited) return undefined;
    if (!same) found.push({ expected: er, expectedNode: expected.getDeclaration()?.type, actual: ar, actualNode: actual.getDeclaration()?.type });
    return found;
  };
  const typePair = (found: Difference[] | undefined): Found | undefined => {
    if (!found?.length) return undefined;
    const pairs = found.map(d => ({ e: named(d.expected, d.expectedNode), a: named(d.actual, d.actualNode), d }));
    if (pairs.some(({ e, a }) => !e || !a || !(e.owned || a.owned))) return undefined;
    const keys = new Set(pairs.map(({ e, a }) => `${e!.key}>${a!.key}`));
    if (keys.size !== 1) return undefined;
    const { e, a, d } = pairs[0];
    const id = `type:${[...keys][0]}`;
    const expected = shown(e!.name, d.expected), actual = shown(a!.name, d.actual);
    // If clipping hides the difference, retain the individual explanations rather than claiming a useful summary.
    return id.length > 2000 || expected === actual ? undefined : { id, summary: `signatures differ from their contracts in one type: expected ${expected}, actual ${actual}` };
  };
  const single = (type: ts.Type) => {
    const calls = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
    return calls.length === 1 && !checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length ? calls[0] : undefined;
  };
  const typeNode = (symbol: ts.Symbol) => {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return declaration && (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) ? declaration.type : undefined;
  };
  return {
    /** A member whose signature or field type differs. */
    member(expectedMember: ts.Symbol, expectedOwner: ts.Type, expectedType: ts.Type, member: ts.Symbol, owner: ts.Type, actualType: ts.Type): Found | undefined {
      const readonly = shape.readonly(member, owner);
      if (readonly === undefined || shape.readonly(expectedMember, expectedOwner) !== readonly || shape.optional(expectedMember) !== shape.optional(member)) return undefined;
      if ([...(expectedMember.declarations ?? []), ...(member.declarations ?? [])].some(d => ts.isSetAccessorDeclaration(d) || ts.isGetAccessorDeclaration(d))) return undefined;
      // An optional member's type carries undefined beside the written one; leave it to the full message.
      if (shape.optional(member)) return undefined;
      const e = single(expectedType), a = single(actualType);
      if (e && a) return typePair(differences(e, a));
      if (checker.getSignaturesOfType(expectedType, ts.SignatureKind.Call).length || checker.getSignaturesOfType(actualType, ts.SignatureKind.Call).length) return undefined;
      return typePair([{ expected: expectedType, expectedNode: typeNode(expectedMember), actual: actualType, actualNode: typeNode(member) }]);
    },
    /** A callable implementation whose call signature differs. */
    calls(expected: ts.Type, actual: ts.Type): Found | undefined {
      const e = checker.getSignaturesOfType(expected, ts.SignatureKind.Call), a = checker.getSignaturesOfType(actual, ts.SignatureKind.Call);
      return e.length === 1 && a.length === 1 ? typePair(differences(e[0], a[0])) : undefined;
    },
    /** An extra member that the tagged class does not declare itself, declared in one class or interface. */
    inherited(member: ts.Symbol, own: ts.ClassDeclaration | undefined): Found | undefined {
      const containers = new Set((member.declarations ?? []).map(d => d.parent));
      const [container] = containers;
      if (containers.size !== 1 || container === own || !(ts.isClassDeclaration(container) || ts.isInterfaceDeclaration(container)) || !container.name) return undefined;
      const kind = ts.isClassDeclaration(container) ? "class" : "interface";
      return { id: `declared:${idOf(container)}`, summary: `public members declared by ${kind} ${container.name.text} are absent from the affected contracts` };
    },
  };
}
