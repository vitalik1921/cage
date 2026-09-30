import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { CAGE_DIRECTORY, GENERATED_FILE_NAME } from "./extraction.ts";

/** A module: the directory that holds its design documents. */
export interface DesignSource {
  /** Project-relative POSIX path of the module root; "." for the project root. */
  moduleId: string;
  /** Absolute paths of the module's `*.cage.mdx` documents, sorted by name. */
  sourceFiles: string[];
  /** Absolute path of `.cage/generated.ts` in the module; the file may not exist. */
  generatedFile: string;
}

/** The suffix that makes a file a design document. */
export const DESIGN_SUFFIX = ".cage.mdx";

/**
 * Finds the design documents of the scope and groups them by directory: the
 * documents of one directory are one module's design. Only files named
 * `*.cage.mdx` count; anything else a pattern matches is not a design.
 */
export function discoverDesigns(root: string, config: Pick<Config, "designs" | "exclude">): DesignSource[] {
  const byModule = new Map<string, string[]>();
  for (const file of findFiles(root, config.designs, config.exclude)) {
    if (!file.endsWith(DESIGN_SUFFIX) || path.posix.basename(file) === DESIGN_SUFFIX) continue;
    const moduleId = path.posix.dirname(file);
    byModule.set(moduleId, [...(byModule.get(moduleId) ?? []), path.join(root, file)]);
  }
  return [...byModule]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([moduleId, sourceFiles]) => ({ moduleId, sourceFiles, generatedFile: path.join(root, moduleId, CAGE_DIRECTORY, GENERATED_FILE_NAME) }));
}

export interface SourceFiles {
  /** Files that may hold `@implements`; project-relative POSIX paths. */
  implementations: string[];
  /** Files that may hold `@tests` and `@covers`. */
  tests: string[];
}

/**
 * The ordinary source files of the scope: `.ts` files only, whatever else
 * the patterns match. A test file is not an implementation, and nothing
 * inside a `.cage` directory is either; declaration files are neither.
 */
export function discoverSources(root: string, config: Pick<Config, "implementations" | "tests" | "exclude">): SourceFiles {
  const isSource = (file: string) => file.endsWith(".ts") && !file.endsWith(".d.ts");
  const tests = findFiles(root, config.tests, config.exclude).filter(isSource);
  const isTest = new Set(tests);
  const inDesign = (file: string) => file.split("/").includes(CAGE_DIRECTORY);
  const implementations = findFiles(root, config.implementations, config.exclude).filter((file) => isSource(file) && !isTest.has(file) && !inDesign(file));
  return { implementations, tests };
}

/**
 * Project-relative POSIX paths of the regular files that match a pattern and
 * no exclude pattern, sorted. Symbolic links are never followed, so every
 * file is found once, under its own path, and nothing outside the root is read.
 */
export function findFiles(root: string, patterns: readonly string[], exclude: readonly string[]): string[] {
  // Files are matched by their path from the root, which has no leading "./".
  const fromRoot = (pattern: string) => pattern.replace(/^(\.\/)+/, "");
  patterns = patterns.map(fromRoot);
  exclude = exclude.map(fromRoot);
  const matches = (candidates: readonly string[], file: string) => candidates.some((pattern) => path.posix.matchesGlob(file, pattern));
  const excludedDirectories = exclude.filter((pattern) => pattern.endsWith("/**")).map((pattern) => pattern.slice(0, -"/**".length));

  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        if (patterns.some((pattern) => mayMatchBelow(file, pattern)) && !matches(excludedDirectories, file)) walk(file);
      } else if (entry.isFile() && matches(patterns, file) && !matches(exclude, file)) {
        found.push(file);
      }
    }
  };
  walk("");
  return found.sort();
}

/** Whether a file below `directory` can match `pattern`, comparing them one path segment at a time. */
function mayMatchBelow(directory: string, pattern: string): boolean {
  // A `/` inside braces: such a pattern cannot be split into segments.
  if (/\{[^}]*\//.test(pattern)) return true;
  const segments = pattern.split("/");
  const names = directory.split("/");
  for (let depth = 0; depth < names.length; depth++) {
    if (segments[depth]?.includes("**")) return true;
    // The last segment names the file: the pattern has no directory this deep.
    if (depth >= segments.length - 1) return false;
    if (!path.posix.matchesGlob(names[depth], segments[depth])) return false;
  }
  return true;
}
