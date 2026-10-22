import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type ts from "typescript";
import type { DesignIndex, PackageImport, PackageTypesFile } from "./design-model.ts";
import { compareText } from "./diagnostic.ts";
import { isCompilerLibrary, selectPackageDependencies, type PackageSelection } from "./package-dependencies.ts";
import { createPackageDiagnostics } from "./package-diagnostics.ts";
import { toProjectPath } from "./location.ts";
import type { Overlay, TypeScript } from "./typescript.ts";

/**
 * How much of a package's declarations a design may reach through one specifier. Past it the import is rejected,
 * never fingerprinted in part: a review or a lock over half the types is not one over the types.
 */
export const PACKAGE_TYPES_LIMITS = { files: 1000, bytes: 32 * 1024 * 1024 };

/** What resolving a design's package import found: the installed package and its declaration closure. */
export type PackageEntry = Pick<PackageImport, "name" | "version" | "directory" | "files" | "resolution" | "resolutionFile" | "origin">;

export type PackageResolution = { entry: PackageEntry } | { problem: string };

export interface PackageTypesResolver {
  /** Undefined when the specifier does not name a package at all (a relative path, `node:fs`, `#internal`). */
  resolve(specifier: string, fromFile: string, mode: ts.ResolutionMode): PackageResolution | undefined;
  select(specifier: string, fromFile: string, mode: ts.ResolutionMode, names: readonly string[]): PackageResolution;
  /** The canonical id of a declaration file reached by an earlier `resolve`, by its file name in the program. */
  idOf(fileName: string): string | undefined;
}

/** The package a bare specifier names: `zod` of `zod/v4`, `@scope/pkg` of `@scope/pkg/sub`. */
export function packageNameOf(specifier: string): string | undefined {
  return /^((?:@[a-z0-9~][\w.~-]*\/)?[a-z0-9~][\w.~-]*)(?:\/|$)/i.exec(specifier)?.[1];
}

/** The package an `npm:` alias installs: `rebrowser-playwright` of `npm:rebrowser-playwright@1.52.0`, `@scope/pkg` of `npm:@scope/pkg`. */
function npmAliasTarget(spec: string | undefined): string | undefined {
  return spec === undefined ? undefined : /^npm:((?:@[^/@\s]+\/)?[^/@\s]+)(?:@.*)?$/.exec(spec.trim())?.[1];
}

/** The DefinitelyTyped package that holds the types of a package: `@types/express`, `@types/babel__core`. */
const typesPackageOf = (name: string) => `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`;

const isDeclarationFile = (fileName: string) => /\.d\.([cm]?ts|[\w-]+\.ts)$/.test(fileName);

interface Installed {
  /** By its package.json: for an npm alias, the target package (`rebrowser-playwright`), not the name it is installed under. */
  name: string;
  /** The name it is installed under, by its real path: `playwright` for `"playwright": "npm:rebrowser-playwright@1.52.0"` in npm's layout. */
  folder: string;
  version: string;
  /** Real, absolute. */
  directory: string;
}

interface FileNode {
  file: PackageTypesFile;
  /** The installed package that holds it. */
  installed: Installed;
}

/** Dependency fields whose `npm:` aliases a package manager installs: for the project all of them, for an installed package not its development ones. */
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const;

/**
 * Resolves the package imports of designs with the project's compiler options, the way the program does, and
 * collects the declaration files each one reaches. What a design may import from a package is decided by where the
 * compiler finds it, not by how the specifier looks: the file must be a declaration file inside the directory of the
 * package the specifier names (or of its `@types` package), under a `node_modules` of the project or of a directory
 * above it (including links to external installations), with a package.json that gives that name and a version.
 * External packages must be reachable through a normal node_modules entry of the project or an already reached
 * package; a manifest elsewhere is not enough. A package of the workspace the project belongs to
 * counts as installed where such a node_modules links to it under its own name (an npm, Yarn or pnpm workspace link):
 * its files are the package's by their real path, inside the package's directory. A path alias that leads to a
 * project file, or to another package, does not make it one. Package files are read as text, nothing of them is executed.
 *
 * An npm alias (`"playwright": "npm:rebrowser-playwright@1.52.0"`) installs a package under a name that is not its own.
 * It is taken when the package.json of the importer, or of a directory between it and the `node_modules` that holds the
 * alias, declares that name as `npm:` of the package's own name, and the `node_modules/<alias>` resolution reaches
 * first leads to the package's directory (directly, or through pnpm's link). The package is then known by its own name
 * and version: what a review or a lock holds of it changes when the alias leads to another package.
 *
 * The closure follows the declarations selected by the imported names, including ambient and global contributors.
 * Every reached file must be one a design may import; the compiler's own default libraries are the boundary.
 * Selected declaration type errors follow the project's `skipLibCheck`; syntax and unresolved selected bindings
 * remain checked. Effective suppressions and unrelated declarations follow the compiler diagnostic selection rules.
 */
export function createPackageTypesResolver(
  ts: TypeScript,
  root: string,
  overlay: Pick<Overlay, "resolveModuleFull" | "resolveTypeReference" | "createProgram">,
  program: ts.Program,
  options: ts.CompilerOptions,
  projectTypes: readonly string[] = [],
): PackageTypesResolver {
  const realRoot = realpath(path.resolve(root));
  const vocabulary = new Map<string, Set<string>>();
  for (const entry of projectTypes) {
    const at = entry.lastIndexOf("#");
    const file = realpath(path.resolve(root, entry.slice(0, at)));
    if (!within(realRoot, file) || file.split(path.sep).includes("node_modules")) continue;
    vocabulary.set(file, new Set([...(vocabulary.get(file) ?? []), entry.slice(at + 1)]));
  }
  const project: Installed = { name: "project", folder: "project", version: "", directory: realRoot };
  const projectFiles = new Map<string, boolean>();
  const isProjectFile = (fileName: string) => {
    const known = projectFiles.get(fileName);
    if (known !== undefined) return known;
    const real = realpath(fileName);
    const local = within(realRoot, real) && !real.split(path.sep).includes("node_modules") && typeof installedAt(real) === "string";
    projectFiles.set(fileName, local);
    return local;
  };
  const manifests = new Map<string, Installed | string>();
  const nodes = new Map<string, FileNode | string>();
  const ids = new Map<string, string>();
  const declared = new Map<string, Map<string, string>>();
  const links = new Map<string, { base: string; directory: string } | undefined>();
  // Keep existing package identities. Only newly supported external installations are displayed through the
  // node_modules path that reaches them, so moving an installation behind a link does not stale its reviews.
  const linkedPackages = new Map<string, { installed: Installed; logical: string }>();
  const holders = new Set([realRoot]);
  const candidates = new Map<string, Installed | null>();
  const logicalPath = (real: string): string => {
    const parent = [...linkedPackages.values()].filter(({ installed }) => within(installed.directory, real))
      .sort((a, b) => b.installed.directory.length - a.installed.directory.length)[0];
    return parent ? path.join(parent.logical, path.relative(parent.installed.directory, real)) : real;
  };
  const shown = (real: string) => toProjectPath(realRoot, logicalPath(real));
  const compilerLibDirectory = path.dirname(ts.getDefaultLibFilePath(options));
  const diagnostics = createPackageDiagnostics(ts, overlay, program);

  /** The package.json of a directory, read once: an installed package by its name and version, or why it is none. */
  const manifestAt = (directory: string, folder?: string): Installed | string => {
    const known = manifests.get(directory);
    if (known !== undefined) return known;
    let found: Installed | string;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      found =
        typeof manifest.name !== "string" || packageNameOf(manifest.name) !== manifest.name
          ? `${shown(directory)}/package.json does not name the package ${folder ?? "it holds"}`
          : typeof manifest.version !== "string" || manifest.version === ""
            ? `${shown(directory)}/package.json has no version`
            : { name: manifest.name, folder: folder ?? manifest.name, version: manifest.version, directory };
    } catch (cause) {
      found = `${shown(directory)}/package.json cannot be read: ${(cause as Error).message.replaceAll(directory, shown(directory))}`;
    }
    manifests.set(directory, found);
    return found;
  };

  let workspace: Workspace | null | undefined;
  /** The workspace the project belongs to: found once, by the package.json files and pnpm-workspace.yaml above the project. */
  const owningWorkspace = () => (workspace === undefined ? (workspace = findWorkspace(realRoot) ?? null) : workspace) ?? undefined;
  const memberDirectories = new Map<string, string | null>();
  /** The workspace package whose directory holds `directory`, by the workspace's patterns; its own `node_modules` hold none. */
  const memberAt = (directory: string): string | undefined => {
    const owner = owningWorkspace();
    if (!owner || !within(owner.root, directory)) return undefined;
    const known = memberDirectories.get(directory);
    if (known !== undefined) return known ?? undefined;
    let found: string | null = null;
    if (!path.relative(owner.root, directory).split(path.sep).includes("node_modules")) {
      for (let candidate = directory; candidate !== owner.root && within(owner.root, candidate); candidate = path.dirname(candidate)) {
        if (owner.matches(path.relative(owner.root, candidate)) && typeof manifestAt(candidate) !== "string") {
          found = candidate;
          break;
        }
      }
    }
    memberDirectories.set(directory, found);
    return found ?? undefined;
  };
  let installedMembers: Set<string> | undefined;
  /**
   * The directories of the installed workspace packages, found once and in no order of what a design reaches. A
   * workspace package is installed when a `node_modules` link under its own name leads to its directory: from one of
   * the directories from the project up to the workspace root, or from an installed workspace package (pnpm links a
   * dependency into the package that depends on it). The candidates are the workspace packages with a file in the
   * program, a fixed set: the compiler loads a file of every package whose link it follows. The installed ones are the
   * least set closed under those links, so a package's acceptance never depends on which file was judged first. Only
   * the links named by those packages are looked at, nothing is listed.
   */
  const installedWorkspacePackages = (): Set<string> => {
    if (installedMembers) return installedMembers;
    const owner = owningWorkspace()!;
    const holders: string[] = [];
    for (let directory = realRoot; within(owner.root, directory); directory = path.dirname(directory)) {
      holders.push(directory);
      if (directory === owner.root) break;
    }
    const candidates = new Map<string, Installed>();
    for (const sourceFile of program.getSourceFiles()) {
      if (isCompilerLibrary(program, sourceFile, compilerLibDirectory)) continue;
      const directory = memberAt(path.dirname(realpath(sourceFile.fileName)));
      const member = directory === undefined ? undefined : manifestAt(directory);
      if (member !== undefined && typeof member !== "string" && !within(member.directory, realRoot)) candidates.set(member.directory, member);
    }
    const installed = new Set<string>();
    // Visit each holder/candidate pair at most once, even when declaration order reverses a long link chain.
    for (let next = 0; next < holders.length; next++) {
      for (const member of candidates.values()) {
        if (realpath(path.join(holders[next], "node_modules", ...member.name.split("/"))) !== member.directory) continue;
        installed.add(member.directory);
        candidates.delete(member.directory);
        holders.push(member.directory);
      }
    }
    return (installedMembers = installed);
  };
  const memberInstalled = (member: Installed): boolean => installedWorkspacePackages().has(member.directory);

  /** The installed package that holds a real path, or why it is none. */
  const localInstalledAt = (real: string): Installed | string => {
    const memberDirectory = memberAt(path.dirname(real));
    const member = memberDirectory === undefined ? undefined : manifestAt(memberDirectory);
    // The workspace package that holds the project is the project: its files are no package's.
    if (member !== undefined && typeof member !== "string" && !within(member.directory, realRoot)) {
      if (!memberInstalled(member)) return `${shown(member.directory)} is the workspace package ${member.name}, but no node_modules of the project, the directories above it up to the workspace root or an installed workspace package links to it`;
      return member;
    }
    const parts = real.split(path.sep);
    const at = parts.lastIndexOf("node_modules");
    const length = parts[at + 1]?.startsWith("@") ? 2 : 1;
    if (at === -1 || parts.length <= at + length + 1) return `${shown(real)} is not inside an installed package`;
    const directory = parts.slice(0, at + 1 + length).join(path.sep);
    const name = parts.slice(at + 1, at + 1 + length).join("/");
    // In the project, or in a node_modules of a directory above it (a workspace that hoists its packages), or of an
    // installed workspace package; not a link to anywhere else.
    const base = parts.slice(0, parts.indexOf("node_modules")).join(path.sep);
    if (!within(realRoot, directory) && !within(base, realRoot)) {
      const owner = memberAt(base);
      const member = owner === undefined ? undefined : manifestAt(owner);
      if (member === undefined || typeof member === "string" || within(member.directory, realRoot) || !memberInstalled(member)) {
        return `${shown(directory)} lies outside the project and the node_modules above it`;
      }
    }
    return manifestAt(directory, name);
  };

  /** Find a package boundary without accepting it: a manifest alone is not an installation. */
  const candidateAt = (real: string): Installed | undefined => {
    const start = path.dirname(real);
    const known = candidates.get(start);
    if (known !== undefined) return known ?? undefined;
    for (let directory = start; ; directory = path.dirname(directory)) {
      if (fs.existsSync(path.join(directory, "package.json"))) {
        const found = manifestAt(directory);
        if (typeof found !== "string") {
          candidates.set(start, found);
          return found;
        }
      }
      if (directory === path.dirname(directory)) break;
    }
    candidates.set(start, null);
    return undefined;
  };

  /** Follow only a real node_modules entry, from the project or a package already reached by its declarations. */
  const installedAt = (real: string): Installed | string => {
    const local = localInstalledAt(real);
    if (typeof local !== "string") {
      holders.add(local.directory);
      return local;
    }
    const candidate = candidateAt(real);
    if (!candidate || within(candidate.directory, realRoot)) return local;
    const known = linkedPackages.get(candidate.directory);
    if (known) return known.installed;
    for (const holder of holders) {
      const names = new Set([candidate.name]);
      // Aliases keep their existing manifest check; the name of a link alone does not rename a package.
      for (let directory = holder; ; directory = path.dirname(directory)) {
        for (const [name, spec] of dependenciesDeclaredIn(directory)) if (npmAliasTarget(spec) === candidate.name) names.add(name);
        if (directory === path.dirname(directory)) break;
      }
      for (const name of names) {
        const link = linkedFrom(holder, name);
        if (!link || link.directory !== candidate.directory) continue;
        const installed = { ...candidate, folder: name };
        const modules = path.join(link.base, "node_modules");
        const realModules = realpath(modules);
        // Preserve pnpm's internal layout when the entire node_modules is linked, too.
        const logical = within(realModules, candidate.directory)
          ? path.join(logicalPath(modules), path.relative(realModules, candidate.directory))
          : path.join(logicalPath(modules), ...name.split("/"));
        linkedPackages.set(candidate.directory, { installed, logical });
        holders.add(candidate.directory);
        return installed;
      }
    }
    return local;
  };

  /** One declaration file: its identity, text, digest and what it depends on; or why a design may not reach it. */
  const nodeOf = (fileName: string, allowProject = false): FileNode | string => {
    const key = `${allowProject}\n${fileName}`;
    const known = nodes.get(key);
    if (known !== undefined) return known;
    const real = realpath(fileName);
    const local = allowProject && within(realRoot, real) && !real.split(path.sep).includes("node_modules");
    const installed = local ? project : installedAt(real);
    let node: FileNode | string;
    if (typeof installed === "string") node = installed;
    else {
      const id = `${local ? "project" : `${installed.name}@${installed.version}`}/${path.relative(installed.directory, real).split(path.sep).join("/")}`;
      // Only a file of the program has the bindings the checker follows; a declaration file a design reaches is one.
      const sourceFile = local || isDeclarationFile(real) ? program.getSourceFile(fileName) : undefined;
      if (!local && !isDeclarationFile(real)) node = `${id}, which is not a declaration file: a design takes a package's types from its declarations, never its source or JavaScript`;
      else if (!sourceFile) node = `${id}, which the compiler did not load`;
      else {
        node = { file: { id, file: shown(real), digest: declarationDigest(ts, sourceFile), text: sourceFile.text.replace(/\r\n?/g, "\n"), routing: [] }, installed };
        ids.set(fileName, id);
        ids.set(real, id);
      }
    }
    nodes.set(key, node);
    return node;
  };

  /** The dependencies a package.json declares, by name; empty when there is none. */
  const dependenciesDeclaredIn = (directory: string): Map<string, string> => {
    const known = declared.get(directory);
    if (known) return known;
    const found = new Map<string, string>();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as Record<string, unknown>;
      const installed = directory.split(path.sep).includes("node_modules");
      for (const field of DEPENDENCY_FIELDS) {
        const entries = manifest[field];
        if (field === "devDependencies" && installed) continue;
        if (typeof entries !== "object" || entries === null) continue;
        for (const [name, spec] of Object.entries(entries)) if (typeof spec === "string" && !found.has(name)) found.set(name, spec);
      }
    } catch {
      // No package.json, or one that is not JSON: it declares nothing.
    }
    declared.set(directory, found);
    return found;
  };

  /** The `node_modules/<name>` that resolution from a directory reaches first: where it is, and the real directory it leads to. */
  const linkedFrom = (start: string, name: string): { base: string; directory: string } | undefined => {
    const key = `${start}\0${name}`;
    if (links.has(key)) return links.get(key);
    let found: { base: string; directory: string } | undefined;
    for (let directory = start; ; directory = path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", ...name.split("/"));
      if (path.basename(directory) !== "node_modules" && fs.existsSync(candidate)) {
        found = { base: directory, directory: realpath(candidate) };
        break;
      }
      if (path.dirname(directory) === directory) break;
    }
    links.set(key, found);
    return found;
  };

  /**
   * Whether `alias` is an npm alias of the installed package for a file: resolution from the file's directory reaches
   * the package through `node_modules/<alias>`, and a package.json from that directory up to the one that holds this
   * `node_modules` declares `"<alias>": "npm:<name>@…"`. Bounded by the depth of the path; nothing is listed.
   */
  const aliasedFor = (fileName: string, alias: string, installed: Installed): boolean => {
    const start = realpath(path.dirname(fileName));
    const link = linkedFrom(start, alias);
    if (!link || link.directory !== installed.directory) return false;
    for (let directory = start; ; directory = path.dirname(directory)) {
      if (npmAliasTarget(dependenciesDeclaredIn(directory).get(alias)) === installed.name) return true;
      if (directory === link.base || path.dirname(directory) === directory) return false;
    }
  };

  /** Every selected file is checked for package provenance before entering the review material. */
  const closure = (entry: string, entered: Installed, selection: PackageSelection, allowProject = false): PackageTypesFile[] | string => {
    const files: PackageTypesFile[] = [];
    const aliased = new Map<string, Installed>();
    // Establish the reachable package set before emitting paths or caching failures. A dependency can occur
    // before its importer in the selected declarations, including cycles and ambient contributions.
    const pending = new Set([entry, ...selection.dependencies].map(realpath));
    while (pending.size > 0) {
      const before = pending.size;
      for (const file of pending) if (typeof installedAt(file) !== "string") pending.delete(file);
      if (pending.size === before) break;
    }
    let bytes = 0;
    for (const next of new Set([entry, ...selection.dependencies])) {
      const node = nodeOf(next, allowProject || selection.globalDependencies.has(next));
      if (typeof node === "string") return node;
      const routing = (selection.routing.get(next) ?? []).map((route) => {
        const [kind, specifier, mode, target] = JSON.parse(route) as [string, string, string, string];
        const routed = nodeOf(target, allowProject || selection.globalDependencies.has(target));
        return JSON.stringify([kind, specifier, mode, typeof routed === "string" ? target : routed.file.id, shown(realpath(target))]);
      });
      files.push({ ...node.file, routing });
      bytes += node.file.text.length;
      if (files.length > PACKAGE_TYPES_LIMITS.files || bytes > PACKAGE_TYPES_LIMITS.bytes) {
        return `more than ${PACKAGE_TYPES_LIMITS.files} declaration files or ${PACKAGE_TYPES_LIMITS.bytes / 1024 / 1024} MiB, more than cage fingerprints for a package`;
      }
      const { installed } = node;
      if (installed.folder !== installed.name && installed.directory !== entered.directory) aliased.set(installed.directory, installed);
    }
    for (const installed of aliased.values()) {
      if (selection.dependencies.some((fileName) => aliasedFor(fileName, installed.folder, installed))) continue;
      return `${shown(installed.directory)}, whose package.json does not name the package ${installed.folder} but ${installed.name}, and nothing that reaches it declares "${installed.folder}": "npm:${installed.name}@…"`;
    }
    return files.sort((a, b) => compareText(a.id, b.id));
  };

  return {
    resolve(specifier, fromFile, mode) {
      const name = packageNameOf(specifier);
      if (name === undefined && vocabulary.size === 0) return undefined;
      const resolved = overlay.resolveModuleFull(specifier, fromFile, mode);
      const allowed = resolved && vocabulary.get(realpath(resolved.resolvedFileName));
      if (resolved && allowed && !resolved.isExternalLibraryImport) {
        const file = realpath(resolved.resolvedFileName);
        const node = nodeOf(resolved.resolvedFileName, true);
        if (typeof node === "string") return { problem: node };
        return { entry: { origin: "project", name: `project:${shown(file)}`, version: "", directory: shown(file), resolution: node.file.id, resolutionFile: shown(file), files: [] } };
      }
      if (name === undefined) return undefined;
      if (!resolved) return { problem: "resolves to no installed package's types: install the package, or correct the specifier" };
      const real = realpath(resolved.resolvedFileName);
      const installed = installedAt(real);
      if (typeof installed === "string" || resolved.isExternalLibraryImport !== true) {
        return { problem: `resolves to ${shown(real)}, not to an installed package${typeof installed === "string" && !installed.endsWith("is not inside an installed package") ? ` (${installed})` : ""}; a path alias does not make a project file a package` };
      }
      const names = [name, typesPackageOf(name)];
      if (!(installed.folder === installed.name && names.includes(installed.name)) && !names.some((alias) => aliasedFor(fromFile, alias, installed))) {
        return {
          problem:
            installed.folder === installed.name
              ? `resolves into the package ${installed.name}, not ${name}`
              : `resolves into ${shown(installed.directory)}, whose package.json does not name the package ${installed.folder} but ${installed.name}, and the project declares no "${installed.folder}": "npm:${installed.name}@…"`,
        };
      }
      const rootNode = nodeOf(resolved.resolvedFileName);
      if (typeof rootNode === "string") return { problem: `is not supported: ${rootNode}` };
      return { entry: { name: installed.name, version: installed.version, directory: shown(installed.directory), resolution: rootNode.file.id, resolutionFile: shown(real), files: [] } };
    },
    select(specifier, fromFile, mode, names) {
      const resolved = this.resolve(specifier, fromFile, mode);
      if (!resolved || "problem" in resolved) return resolved ?? { problem: "resolves to no installed package's types" };
      const rootFile = overlay.resolveModuleFull(specifier, fromFile, mode)?.resolvedFileName;
      const sourceFile = rootFile && program.getSourceFile(rootFile);
      if (!sourceFile) return { problem: "has no declaration entry point loaded by the compiler" };
      const isProject = resolved.entry.origin === "project";
      const entered = isProject ? project : installedAt(realpath(rootFile));
      if (typeof entered === "string") return { problem: entered };
      if (isProject) {
        const allowed = vocabulary.get(realpath(rootFile))!;
        const checker = program.getTypeChecker();
        const module = checker.getSymbolAtLocation(sourceFile);
        const exported = module ? checker.getExportsOfModule(module) : [];
        for (const name of names) {
          if (!allowed.has(name)) return { problem: `${name} is not designated in designImportableTypes` };
          const binding = exported.find((symbol) => symbol.name === name);
          const symbol = binding && binding.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(binding) : binding;
          if (!symbol || !(symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Enum))) {
            return { problem: `${name} must export a type alias, interface or enum; runtime functions, objects and classes cannot be imported as contract vocabulary` };
          }
        }
      }
      const selection = selectPackageDependencies(
        ts, program.getTypeChecker(), program, sourceFile, names,
        (module, from, usageMode) => overlay.resolveModuleFull(module, from, usageMode)?.resolvedFileName,
        (name, from, usageMode) => overlay.resolveTypeReference(name, from, usageMode)?.resolvedFileName,
        isProject,
        isProjectFile,
      );
      const files = closure(rootFile, entered, selection, isProject);
      if (typeof files === "string") return { problem: `is not supported: its declarations reach ${files}` };
      const invalid = diagnostics.diagnosticsFor(selection)[0];
      if (invalid) {
        const location = invalid.file && invalid.start !== undefined ? invalid.file.getLineAndCharacterOfPosition(invalid.start) : undefined;
        const where = invalid.file ? `${shown(realpath(invalid.file.fileName))}${location ? `:${location.line + 1}:${location.character + 1}` : ""}` : "a package declaration";
        return { problem: `has an error in a selected declaration: ${where} TS${invalid.code} ${ts.flattenDiagnosticMessageText(invalid.messageText, " ")}` };
      }
      for (const missing of selection.unresolved) {
        if (diagnostics.hasErrorAt(missing.file.fileName, missing.start, missing.end)) {
          const location = missing.file.getLineAndCharacterOfPosition(missing.start);
          return { problem: `has an unresolved selected declaration: ${shown(realpath(missing.file.fileName))}:${location.line + 1}:${location.character + 1} ${missing.message}` };
        }
      }
      return { entry: { ...resolved.entry, files } };
    },
    idOf: (fileName) => ids.get(fileName),
  };
}

/**
 * The digest of a declaration file: its tokens, compiler directives and reference directives. Tokens
 * rather than syntax kinds, so that the digest is the same for TypeScript 5 and 6 and a lock does not move with the compiler.
 */
export function declarationDigest(ts: TypeScript, sourceFile: ts.SourceFile): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, sourceFile.text);
  const tokens: string[] = [];
  // Open braces inside each template literal being scanned: the closing one of `${…}` continues the template.
  const templates: number[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (templates.length > 0) {
      if (token === ts.SyntaxKind.OpenBraceToken) templates[templates.length - 1]++;
      else if (token === ts.SyntaxKind.CloseBraceToken && templates[templates.length - 1] > 0) templates[templates.length - 1]--;
      else if (token === ts.SyntaxKind.CloseBraceToken) {
        token = scanner.reScanTemplateToken(false);
        if (token === ts.SyntaxKind.TemplateTail) templates.pop();
      }
    }
    if (token === ts.SyntaxKind.TemplateHead) templates.push(0);
    tokens.push(scanner.getTokenText());
  }
  const reference = (kind: string, value: ts.FileReference) => [kind, value.fileName, value.resolutionMode ?? null];
  const references = [
    ...sourceFile.referencedFiles.map((value) => reference("path", value)),
    ...sourceFile.typeReferenceDirectives.map((value) => reference("types", value)),
    ...sourceFile.libReferenceDirectives.map((value) => reference("lib", value)),
  ];
  // Ordinary comments are immaterial. Compiler suppression comments are input to the checker and can change the
  // apparent package API, so retain both their text and their location relative to declaration tokens.
  const trivia = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, sourceFile.text);
  const suppressions: [number, number, string][] = [];
  const tokenLines: number[] = [];
  let tokenIndex = 0;
  for (let token = trivia.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = trivia.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const comment = trivia.getTokenText();
      if (/@ts-(?:ignore|expect-error|nocheck|check)|<reference\s+no-default-lib\b/.test(comment)) {
        const line = sourceFile.getLineAndCharacterOfPosition(trivia.getTokenPos()).line;
        suppressions.push([tokenIndex, line, comment]);
      }
    } else if (token !== ts.SyntaxKind.WhitespaceTrivia && token !== ts.SyntaxKind.NewLineTrivia) {
      tokenLines.push(sourceFile.getLineAndCharacterOfPosition(trivia.getTokenPos()).line);
      tokenIndex++;
    }
  }
  // Relative line positions retain whether a directive suppresses a token after a line move. Leading prose does not
  // change that relationship, and packages without compiler directives retain ordinary layout insensitivity.
  const firstDirectiveLine = suppressions[0]?.[1] ?? 0;
  const directives = suppressions.map(([index, line, comment]) => [index, line - firstDirectiveLine, comment]);
  const layout = suppressions.length > 0 ? tokenLines.map((line) => line - firstDirectiveLine) : [];
  return digest(JSON.stringify([tokens, references, sourceFile.hasNoDefaultLib, directives, layout]));
}

/** Omit package versions from lock routes so an unchanged declaration and routing survives a version-only update. */
const withoutVersion = (id: string) => id.replace(/^((?:@[^/]+\/)?[^@/]+)@[^/]+\//, "$1/");
const withoutPhysicalVersion = (file: string) => file.replace(/(\/\.pnpm\/)([^/]+)(\/node_modules\/)/g, (_match, prefix: string, encoded: string, suffix: string) => {
  // pnpm encodes the package and each peer as `name@version`, separated by `_`. Strip each version separately;
  // taking only the last `@` of the whole segment would retain the package's version when peers are present.
  const normalized = encoded.split("_").map((part) => {
    const at = part.lastIndexOf("@");
    return at > 0 ? `${part.slice(0, at)}@` : part;
  }).join("_");
  return `${prefix}${normalized}${suffix}`;
});
const normalizedRoute = (route: string, identify: (file: string) => string): string => {
  const parsed: unknown = JSON.parse(route);
  if (!Array.isArray(parsed) || parsed.length !== 5 || !parsed.every((item) => typeof item === "string")) return route;
  return JSON.stringify([parsed[0], parsed[1], parsed[2], withoutVersion(parsed[3] as string), identify(parsed[4] as string)]);
};

/** A declaration reached by several imports keeps the union of the routes each import selected from it. */
const collectedFiles = (imports: readonly PackageImport[]): PackageTypesFile[] => {
  const files = new Map<string, PackageTypesFile>();
  for (const entry of imports) for (const file of entry.files) {
    const previous = files.get(file.file);
    files.set(file.file, previous ? { ...previous, routing: [...new Set([...previous.routing, ...file.routing])].sort(compareText) } : file);
  }
  return [...files.values()];
};

/** The versioned package type digest also holds entry and internal routing for every selected dependency instance. */
export function typesDigest(imports: readonly PackageImport[]): string {
  const selected = collectedFiles(imports);
  const physical = new Set([...selected.map((file) => file.file), ...imports.map((entry) => entry.resolutionFile)]);
  for (const file of selected) for (const route of file.routing) {
    const parsed: unknown = JSON.parse(route);
    if (Array.isArray(parsed) && typeof parsed[4] === "string") physical.add(parsed[4]);
  }
  const groups = new Map<string, Set<string>>();
  for (const file of physical) {
    const normalized = withoutPhysicalVersion(file);
    groups.set(normalized, new Set([...(groups.get(normalized) ?? []), file]));
  }
  // If two selected instances normalize to one path (different peer contexts, for example), retain their physical
  // paths. A version-only update in an unambiguous location still keeps the same lock digest.
  const identify = (file: string) => {
    const normalized = withoutPhysicalVersion(file);
    return (groups.get(normalized)?.size ?? 0) > 1 ? file : normalized;
  };
  const routes = [...new Set(imports.map((entry) => JSON.stringify([withoutVersion(entry.resolution), identify(entry.resolutionFile)])))].sort(compareText);
  const files = selected.map((file) => [withoutVersion(file.id), identify(file.file), file.digest, ...file.routing.map((route) => normalizedRoute(route, identify)).sort(compareText)]);
  // Keep duplicate paths as separate rows: two physical copies (including copies with the same version) both matter.
  files.sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  return `sha256:types-v2:${crypto.createHash("sha256").update(JSON.stringify([routes, files])).digest("hex")}`;
}

/**
 * Records in every locked declaration the types of the packages it depends on, as `:package <name>` members: a new
 * version of their declarations changes the declaration as an edit would. What it depends on is found through the
 * checker's symbols: the names it is written with, followed through the declarations of designs they lead to (a local
 * data type that aliases a package type, a base of an imported design, transitively, each declaration once), up to
 * the package imports they come from. A package the module imports but nothing of this reaches is not recorded.
 * `designs` maps each design's generated file to its module.
 */
export function capturePackageLocks(ts: TypeScript, checker: ts.TypeChecker, index: DesignIndex, designs: ReadonlyMap<ts.SourceFile, string>, writtenSpecifier: (specifier: ts.StringLiteralLike, file: ts.SourceFile) => string = (specifier) => specifier.text): void {
  const topLevel = (node: ts.Node): ts.Node | undefined => {
    let statement = node;
    while (statement.parent && !ts.isSourceFile(statement.parent)) statement = statement.parent;
    return statement.parent ? statement : undefined;
  };
  /** The package import an alias declaration belongs to, if it is one. */
  const packageImportOf = (declaration: ts.Declaration): PackageImport | undefined => {
    const statement = topLevel(declaration);
    const module = designs.get(declaration.getSourceFile());
    if (!statement || module === undefined || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return undefined;
    const specifier = writtenSpecifier(statement.moduleSpecifier, declaration.getSourceFile());
    return index.packages.find((entry) => entry.module === module && entry.specifier === specifier);
  };
  for (const locked of index.locked) {
    const sourceFile = [...designs].find(([, module]) => module === locked.module)?.[0];
    const own = sourceFile?.statements.find((statement) => (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === locked.name);
    if (!own) continue;
    const found = new Set<PackageImport>();
    // Declarations of designs already followed: a cycle of types or a shared alias is read once.
    const seen = new Set<ts.Node>([own]);
    const queue: ts.Node[] = [own];
    const visit = (node: ts.Node): void => {
      const symbol = ts.isIdentifier(node) ? checker.getSymbolAtLocation(node) : undefined;
      if (symbol) {
        let target = symbol;
        if (symbol.flags & ts.SymbolFlags.Alias) {
          for (const declaration of symbol.declarations ?? []) {
            const entry = packageImportOf(declaration);
            if (entry) found.add(entry);
          }
          target = checker.getAliasedSymbol(symbol);
        }
        for (const declaration of target.declarations ?? []) {
          // A namespace import of a design names its module; the member written after it is followed on its own.
          if (ts.isSourceFile(declaration) || !designs.has(declaration.getSourceFile())) continue;
          const statement = topLevel(declaration);
          if (statement && !seen.has(statement)) {
            seen.add(statement);
            queue.push(statement);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) visit(next);
    const imports = new Map<string, PackageImport[]>();
    for (const entry of found) imports.set(entry.name, [...(imports.get(entry.name) ?? []), entry]);
    for (const [name, reached] of [...imports].sort(([a], [b]) => compareText(a, b))) locked.members[`:package ${name}`] = typesDigest(reached);
  }
}

/**
 * The declarations a design names from a package, by the module's exports as the type checker sees them: aliases
 * followed to the declaration, each top-level statement once.
 */
export function namedDeclarations(ts: TypeScript, checker: ts.TypeChecker, specifier: ts.StringLiteralLike, names: readonly string[], idOf: (fileName: string) => string | undefined): PackageImport["declarations"] {
  const moduleSymbol = checker.getSymbolAtLocation(specifier);
  if (!moduleSymbol) return [];
  const exports = checker.getExportsOfModule(moduleSymbol);
  const found: PackageImport["declarations"] = [];
  const seen = new Set<ts.Node>();
  for (const name of names) {
    const exported = exports.find((symbol) => symbol.name === name);
    if (!exported) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    for (const declaration of symbol.declarations ?? []) {
      let statement: ts.Node = declaration;
      while (statement.parent && !ts.isSourceFile(statement.parent) && !ts.isModuleBlock(statement.parent)) statement = statement.parent;
      if (seen.has(statement)) continue;
      seen.add(statement);
      const sourceFile = statement.getSourceFile();
      const id = idOf(sourceFile.fileName);
      if (id === undefined) continue;
      found.push({ name, id, line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1, text: statement.getText(sourceFile) });
    }
  }
  return found;
}

/**
 * The metadata part of the imports of one package: the versions, what the contract's designs import from it and where
 * the named declarations stand, and the declaration files reached. Each of those files is a part of its own, with its
 * text; this part names them, so that a file newly reached or no longer reached is a change too.
 */
export function packageMaterial(imports: readonly PackageImport[]): { text: string; fingerprintText: string; files: PackageTypesFile[] } {
  const sorted = [...imports].sort((a, b) => compareText(a.module, b.module) || compareText(a.specifier, b.specifier));
  const files = collectedFiles(sorted)
    .sort((a, b) => compareText(a.id, b.id) || compareText(a.file, b.file));
  const versions = [...new Set(sorted.map((entry) => entry.origin === "project" ? entry.name : `${entry.name}@${entry.version}`))].sort(compareText);
  const declared = [...new Set(sorted.flatMap((entry) => entry.declarations.map((declaration) => `${declaration.name}: ${declaration.id}:${declaration.line}`)))];
  const lines = [
    `${sorted[0]?.origin === "project" ? "project vocabulary" : "package"} ${versions.join(", ")}: types only, never executed`,
    ...sorted.map((entry) => `imported by ${entry.module}: "${entry.specifier}" -> ${entry.resolution} (${entry.resolutionFile}); ${entry.names.length > 0 ? entry.names.join(", ") : "(no name used)"}`),
    ...(declared.length > 0 ? ["declared at:", ...declared] : []),
    "declaration files (each one in the material):",
    ...files.map((file) => `${file.id} (${file.file})${file.routing.length > 0 ? `\n  resolves: ${file.routing.join("; ")}` : ""}`),
  ];
  const fingerprintText = JSON.stringify({
    scheme: "package-v2",
    versions,
    imports: sorted.map((entry) => [entry.module, entry.specifier, entry.names, entry.resolution, entry.resolutionFile]),
    files: files.map((file) => [file.id, file.file, file.routing]),
  });
  return { text: `${lines.join("\n")}\n`, fingerprintText, files };
}

interface Workspace {
  /** Real, absolute. */
  root: string;
  /** Whether a directory, relative to the root, is one of the workspace's packages by its patterns. */
  matches(relative: string): boolean;
}

/**
 * The nearest directory at or above the project whose package.json lists `workspaces` (an array, or `{ packages }`)
 * or that has a pnpm-workspace.yaml with `packages`, and whose patterns take in the project: the root itself or a
 * directory between them. Patterns are matched against paths, never expanded: no directory is listed.
 */
function findWorkspace(realRoot: string): Workspace | undefined {
  for (let directory = realRoot; ; directory = path.dirname(directory)) {
    const patterns = workspacePatterns(directory);
    if (patterns.length > 0) {
      const include = patterns.filter((pattern) => !pattern.startsWith("!")).map(patternSegments);
      const exclude = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => patternSegments(pattern.slice(1)));
      const matches = (relative: string) => {
        const segments = relative.split(path.sep).filter((segment) => segment !== "");
        return segments.length > 0 && include.some((pattern) => matchSegments(pattern, segments)) && !exclude.some((pattern) => matchSegments(pattern, segments));
      };
      for (let inner = realRoot; ; inner = path.dirname(inner)) {
        if (inner === directory || matches(path.relative(directory, inner))) return { root: directory, matches };
        if (path.dirname(inner) === directory) break;
      }
    }
    if (path.dirname(directory) === directory) return undefined;
  }
}

/** The workspace patterns a directory declares: package.json `workspaces` and pnpm-workspace.yaml `packages`. */
function workspacePatterns(directory: string): string[] {
  const patterns: string[] = [];
  const strings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as { workspaces?: unknown };
    const workspaces = manifest.workspaces;
    patterns.push(...strings(workspaces), ...(workspaces && typeof workspaces === "object" && !Array.isArray(workspaces) ? strings((workspaces as { packages?: unknown }).packages) : []));
  } catch {
    // No package.json, or none that parses: it declares no workspace.
  }
  try {
    patterns.push(...pnpmPackages(fs.readFileSync(path.join(directory, "pnpm-workspace.yaml"), "utf8")));
  } catch {
    // No pnpm workspace.
  }
  // A pattern that leaves the root or names nothing takes in no package.
  return patterns.map((pattern) => pattern.trim()).filter((pattern) => !/(^|\/)\.\.(\/|$)/.test(pattern) && patternSegments(pattern.replace(/^!/, "")).length > 0);
}

/**
 * The `packages` list of a pnpm-workspace.yaml, in the forms pnpm documents: a block sequence of scalars, plain or
 * quoted, or a flow sequence on the key's line. Anything else in the file is not read.
 */
function pnpmPackages(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start === -1) return [];
  const scalar = (value: string) => {
    const trimmed = value.trim();
    const quoted = /^(["'])(.*?)\1\s*(#.*)?$/.exec(trimmed);
    return quoted ? quoted[2] : trimmed.replace(/\s+#.*$/, "");
  };
  const rest = lines[start].replace(/^packages\s*:/, "").replace(/\s+#.*$/, "").trim();
  if (rest.startsWith("[")) return rest.endsWith("]") ? rest.slice(1, -1).split(",").map(scalar).filter((item) => item !== "") : [];
  if (rest !== "") return [];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+(.+)$/.exec(line) ?? /^-\s+(.+)$/.exec(line);
    if (!item) break;
    found.push(scalar(item[1]));
  }
  return found;
}

/** A workspace pattern as path segments: `*` and `?` within a segment, `**` for any number of segments. */
function patternSegments(pattern: string): (RegExp | "**")[] {
  return pattern
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .map((segment) => (segment === "**" ? "**" : new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]")}$`)));
}

function matchSegments(pattern: readonly (RegExp | "**")[], segments: readonly string[]): boolean {
  if (pattern.length === 0) return segments.length === 0;
  const [head, ...rest] = pattern;
  if (head === "**") return segments.some((_, i) => matchSegments(rest, segments.slice(i))) || matchSegments(rest, []);
  return segments.length > 0 && head.test(segments[0]) && matchSegments(rest, segments.slice(1));
}

const digest = (text: string) => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;

function realpath(fileName: string): string {
  try {
    return fs.realpathSync(fileName);
  } catch {
    return fileName;
  }
}

/** Whether `inner` is `outer` or below it. */
function within(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
