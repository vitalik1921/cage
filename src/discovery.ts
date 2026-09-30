import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.ts";
import { GENERATED_FILE_NAME } from "./extraction.ts";

export interface DesignSource {
  /** Project-relative POSIX path of the module root; "." for the project root. */
  moduleId: string;
  /** Absolute path of the authored design.mdx. */
  sourceFile: string;
  /** Absolute path of the design.generated.ts next to it; the file may not exist. */
  generatedFile: string;
}

const MODULE_MARKER = ".design/design.mdx";

/**
 * Finds the design documents of the scope, sorted by path. Only files named
 * `.design/design.mdx` are module markers; anything else a pattern matches,
 * such as a generated file, is not a design.
 */
export function discoverDesigns(root: string, config: Pick<Config, "designs" | "exclude">): DesignSource[] {
  return findFiles(root, config.designs, config.exclude)
    .filter((file) => file === MODULE_MARKER || file.endsWith(`/${MODULE_MARKER}`))
    .map((file) => {
      const designDirectory = path.posix.dirname(file);
      return {
        moduleId: path.posix.dirname(designDirectory),
        sourceFile: path.join(root, file),
        generatedFile: path.join(root, designDirectory, GENERATED_FILE_NAME),
      };
    });
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
