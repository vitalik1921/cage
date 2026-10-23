import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { DesignIndex } from "./design-model.ts";
import type { TypeScript } from "./typescript.ts";

export interface PackageInstanceScope {
  base: ts.Type;
  members: string[];
}

/** Only declaration files already validated and fingerprinted as installed packages qualify. */
export function packageDeclarationFiles(root: string, index: DesignIndex): (file: ts.SourceFile) => boolean {
  let files: Set<string> | undefined;
  const cache = new Map<string, boolean>();
  return file => {
    let known = cache.get(file.fileName);
    if (known === undefined) {
      files ??= new Set([...new Set(index.packages.flatMap(entry => entry.files)
        .filter(file => /^((?:@[^/]+\/)?[^@/]+)@[^/]+\//.test(file.id))
        .map(file => path.resolve(root, file.file)))].flatMap(file => {
          try { return [fs.realpathSync(file)]; } catch { return []; }
        }));
      try { known = file.isDeclarationFile && files.has(fs.realpathSync(file.fileName)); }
      catch { known = false; }
      cache.set(file.fileName, known);
    }
    return known;
  };
}

/** Resolve an explicit package-instance boundary without inferring it from structural resemblance. */
export function packageInstanceChecker(ts: TypeScript, checker: ts.TypeChecker, isPackageFile: (file: ts.SourceFile) => boolean) {
  const classSymbol = (type: ts.Type) => {
    const symbol = type.getSymbol();
    return symbol && symbol.flags & ts.SymbolFlags.Class ? symbol : undefined;
  };
  const packageClass = (type: ts.Type) => {
    const declarations = classSymbol(type)?.declarations?.filter(ts.isClassDeclaration);
    return !!declarations?.length && declarations.every(node => isPackageFile(node.getSourceFile()));
  };
  const scope = (type: ts.Type): PackageInstanceScope | undefined => {
    const bases = new Set<ts.Type>(), seen = new Set<ts.Type>();
    const visit = (current: ts.Type): void => {
      if (seen.has(current)) return;
      seen.add(current);
      if (classSymbol(current)) {
        if (packageClass(current)) bases.add(current);
        return;
      }
      if (current.isIntersection()) current.types.forEach(visit);
      else if (current.isClassOrInterface()) checker.getBaseTypes(current).forEach(visit);
    };
    visit(type);
    if (bases.size !== 1) return undefined;
    const [base] = bases;
    // A redeclaration in a design, including one inherited from a family, stays an exact promise.
    // So does a project augmentation: physical package origin is required for every declaration we omit.
    const members = checker.getPropertiesOfType(type).filter(member =>
      !member.declarations?.length || !member.declarations.every(node => isPackageFile(node.getSourceFile()))).map(member => member.name);
    return { base, members };
  };
  const instance = (type: ts.Type, expected: PackageInstanceScope): ts.Type | undefined => {
    const parts = type.isIntersection() ? type.types : [type];
    if (parts.some(part => checker.getSignaturesOfType(part, ts.SignatureKind.Construct).length)) return undefined;
    const classes = parts.filter(part => classSymbol(part));
    if (classes.length !== 1 || !packageClass(classes[0])) return undefined;
    return classSymbol(classes[0]) === classSymbol(expected.base) ? classes[0] : undefined;
  };
  const supplied = (member: ts.Symbol, instance: ts.Type, actual: ts.Type) => {
    // Mapped intersections can change modifiers/types while retaining the library's declaration nodes.
    // A second constituent claiming the member is an override even when those nodes look identical.
    if (actual.isIntersection() && actual.types.some(part => part !== instance && checker.getPropertyOfType(part, member.name))) return false;
    const original = checker.getPropertyOfType(instance, member.name);
    // An intersection or override may keep the library declaration alongside project declarations.
    // Only an unchanged inherited member can be omitted, never a project-added/replaced member.
    return !!member.declarations?.length && member.declarations.every(node => original?.declarations?.includes(node));
  };
  return { scope, instance, supplied };
}
