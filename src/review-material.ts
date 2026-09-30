import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Contract, Edge, Implementation, TestDeclaration } from "./design-model.ts";
import type { DesignModule } from "./design-phase.ts";
import { compareText, type Diagnostic } from "./diagnostic.ts";
import type { ImplementationPhaseResult } from "./implementation-phase.ts";
import { stripBom } from "./location.ts";

/** A file the reviewer reads, once, whatever number of contracts it serves. Its text has `\n` line endings whatever the disk has. */
export interface PacketFile {
  path: string;
  role: "design" | "implementation" | "test";
  text: string;
  /** Of the normalized text, so that the line endings of a checkout do not count as a change. */
  digest: string;
}

/** The files a contract's review is made of, and what they were found for. */
export interface Material {
  contract: Contract;
  own: DesignModule;
  dependencyDesigns: string[];
  uses: { contract: string; module: string }[];
  usedBy: { contract: string; module: string }[];
  implementations: Implementation[];
  declarations: TestDeclaration[];
  testFiles: string[];
  files: PacketFile[];
}

export type FileReader = (file: string, role: PacketFile["role"], text?: string) => PacketFile | undefined;

/** A reader that loads each file once and reports what cannot be read. */
export function createFileReader(root: string, diagnostics: Diagnostic[]): { read: FileReader; files: Map<string, PacketFile> } {
  const files = new Map<string, PacketFile>();
  const read: FileReader = (file, role, text) => {
    const known = files.get(file);
    if (known) return known;
    try {
      const normalized = (text ?? stripBom(fs.readFileSync(path.join(root, file), "utf8"))).replace(/\r\n?/g, "\n");
      const loaded = { path: file, role, text: normalized, digest: digestOf(normalized) };
      files.set(file, loaded);
      return loaded;
    } catch (cause) {
      diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot read a file of the review: ${(cause as Error).message}`, file });
      return undefined;
    }
  };
  return { read, files };
}

/**
 * Collects what a reviewer of a contract reads: the module's design, the
 * designs of the contracts it uses and of the modules its own imports
 * types from (transitively), the tagged implementations and the files of
 * the linked test declarations.
 */
export function collectMaterial(result: ImplementationPhaseResult, name: string, read: FileReader): Material {
  const { modules, index, linking } = result;
  const contract = index!.contracts.find((candidate) => candidate.name === name)!;
  const moduleOf = (moduleId: string) => modules.find((module) => module.moduleId === moduleId)!;
  const own = moduleOf(contract.module);
  const files: PacketFile[] = [];
  const include = (file: PacketFile | undefined) => {
    if (file && !files.includes(file)) files.push(file);
  };
  for (const document of own.documents) include(read(document.file, "design", document.source));

  const usesEdges = index!.edges.filter((edge): edge is Edge & { kind: "uses" } => edge.kind === "uses");
  const uses = usesEdges.filter((edge) => edge.from === name).map((edge) => ({ contract: edge.to, module: edge.toModule }));
  const usedBy = usesEdges.filter((edge) => edge.to === name).map((edge) => ({ contract: edge.from, module: edge.fromModule }));
  const reached = new Set<string>([contract.module]);
  const queue = [contract.module];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const edge of index!.edges) {
      if (edge.kind === "type-import" && edge.fromModule === next && !reached.has(edge.toModule)) {
        reached.add(edge.toModule);
        queue.push(edge.toModule);
      }
    }
  }
  for (const { module } of uses) reached.add(module);
  reached.delete(contract.module);
  const dependencyModules = [...reached].sort(compareText);
  for (const moduleId of dependencyModules) for (const document of moduleOf(moduleId).documents) include(read(document.file, "design", document.source));

  const implementations = (linking?.implementations ?? []).filter((implementation) => implementation.contract === name);
  for (const implementation of implementations) include(read(implementation.location.file, "implementation"));
  const declarations = (linking?.tests ?? []).filter((test) => test.contract === name);
  const testFiles = [...new Set(declarations.map((test) => test.location.file))].sort(compareText);
  for (const file of testFiles) include(read(file, "test"));

  return { contract, own, dependencyDesigns: dependencyModules.flatMap((moduleId) => moduleOf(moduleId).documents.map((document) => document.file)), uses, usedBy, implementations, declarations, testFiles, files };
}

export const digestOf = (text: string) => `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;

/** The digest of every file of the material, by path, and of all of them together. */
export function fingerprintOf(files: readonly PacketFile[]): { fingerprint: string; digests: Record<string, string> } {
  const sorted = [...files].sort((a, b) => compareText(a.path, b.path));
  const hash = crypto.createHash("sha256");
  for (const file of sorted) hash.update(`${file.path}\n${file.digest}\0`);
  return { fingerprint: `sha256:${hash.digest("hex")}`, digests: Object.fromEntries(sorted.map((file) => [file.path, file.digest])) };
}

