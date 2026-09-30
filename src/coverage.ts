import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "./diagnostic.ts";
import { splitLines, stripBom } from "./location.ts";

/** Relative to the module root. */
export const IGNORE_FILE = ".cage/ignore";

/** A module with a design: where it is, and which of its files its design deliberately leaves out. */
export interface ModuleScope {
  moduleId: string;
  /** Whether a file, given relative to the project root, is listed in the module's ignore file. */
  ignores: (file: string) => boolean;
}

/**
 * Reads each module's `.cage/ignore`: the files and folders that need no
 * design. For a person or an LLM working on the module it says "do not write
 * a contract for this"; for the harness, "do not warn that there is none".
 *
 * One pattern per line, relative to the module root, as in a `.gitignore`:
 * `entities/` is a folder at any depth, `*.module.ts` a file name at any
 * depth, `dto/request/upsert.ts` and `/generated` are paths from the module
 * root. `#` starts a comment. Negation (`!`) is not supported.
 */
export function readModuleScopes(root: string, moduleIds: readonly string[]): { scopes: ModuleScope[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const scopes = moduleIds.map((moduleId): ModuleScope => {
    const file = path.posix.join(moduleId, IGNORE_FILE);
    let text = "";
    try {
      text = stripBom(fs.readFileSync(path.join(root, file), "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
        diagnostics.push({ code: "E_ENVIRONMENT", severity: "error", message: `Cannot read the ignore file: ${(cause as Error).message}`, file });
      }
    }
    const globs: string[] = [];
    splitLines(text).forEach((line, index) => {
      const pattern = line.text.trim();
      if (pattern === "" || pattern.startsWith("#")) return;
      if (pattern.startsWith("!")) {
        diagnostics.push({ code: "E_CONFIG", severity: "error", message: "Negated patterns (`!`) are not supported in an ignore file.", file, line: index + 1, column: 1 });
        return;
      }
      globs.push(...toGlobs(pattern));
    });
    const prefix = moduleId === "." ? "" : `${moduleId}/`;
    return { moduleId, ignores: (candidate) => globs.some((glob) => path.posix.matchesGlob(candidate.slice(prefix.length), glob)) };
  });
  return { scopes, diagnostics };
}

/** The globs of one ignore pattern, with `.gitignore` meaning: a name matches at any depth, a path is anchored at the module root. */
function toGlobs(pattern: string): string[] {
  const folderOnly = pattern.endsWith("/");
  const body = pattern.replace(/\/$/, "");
  const anchored = body.includes("/");
  const path_ = body.replace(/^\//, "");
  const bases = anchored ? [path_] : [path_, `**/${path_}`];
  return folderOnly ? bases.map((base) => `${base}/**`) : bases.flatMap((base) => [base, `${base}/**`]);
}

/** The module that owns a file: the nearest one above it. Undefined for a file outside every module. */
export function ownerOf(scopes: readonly ModuleScope[], file: string): ModuleScope | undefined {
  const owns = ({ moduleId }: ModuleScope) => moduleId === "." || file.startsWith(`${moduleId}/`);
  // The root module is above every other one, however short their names are.
  const depth = ({ moduleId }: ModuleScope) => (moduleId === "." ? 0 : moduleId.length);
  return scopes.filter(owns).sort((a, b) => depth(b) - depth(a))[0];
}
