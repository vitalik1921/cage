import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "./diagnostic.ts";
import { stripBom, toProjectPath } from "./location.ts";

/** Paths and glob patterns are relative to the project root and use `/`. */
export interface Config {
  version: 1;
  tsconfig: string;
  designs: string[];
  implementations: string[];
  tests: string[];
  exclude: string[];
  testAdapter: "node:test" | "vitest";
  /** Whether each design has a `design.generated.ts` on disk, written by `extract` and required by `check`. */
  generatedFiles: boolean;
  /** How `check` treats a contract without a fresh recorded review: not at all, as a warning, or as an error. */
  review: "off" | "warn" | "require";
}

export const DEFAULT_CONFIG_FILE = ".design/config.json";

export const defaultConfig: Config = {
  version: 1,
  tsconfig: "tsconfig.json",
  designs: ["src/**/.design/design.mdx"],
  implementations: ["src/**/*.ts"],
  tests: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
  testAdapter: "node:test",
  generatedFiles: true,
  review: "warn",
};

export interface LoadedConfig {
  config: Config;
  diagnostics: Diagnostic[];
}

/**
 * Loads `configPath` (relative to `root`), or `.design/config.json` when it
 * exists, or the defaults. Fields left out of the file keep their defaults;
 * a given array replaces the default one.
 */
export function loadConfig(root: string, configPath?: string): LoadedConfig {
  const file = path.resolve(root, configPath ?? DEFAULT_CONFIG_FILE);
  const error = (message: string): Diagnostic => ({ code: "E_CONFIG", severity: "error", message, file: toProjectPath(root, file) });

  let text: string;
  try {
    text = stripBom(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    if (configPath === undefined && (cause as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultConfig, diagnostics: [] };
    return { config: defaultConfig, diagnostics: [error(`Cannot read the configuration: ${(cause as Error).message}`)] };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return { config: defaultConfig, diagnostics: [error(`The configuration is not valid JSON: ${(cause as Error).message}`)] };
  }

  const problems = validate(value);
  if (problems.length > 0) return { config: defaultConfig, diagnostics: problems.map(error) };
  return { config: { ...defaultConfig, ...(value as Partial<Config>) }, diagnostics: [] };
}

const isText = (value: unknown) => typeof value === "string" && value.trim() !== "";
const isTextList = (value: unknown) => Array.isArray(value) && value.every(isText);

const fields: Record<keyof Config, { expected: string; valid: (value: unknown) => boolean }> = {
  version: { expected: "1", valid: (value) => value === 1 },
  tsconfig: { expected: "a non-empty string", valid: isText },
  designs: { expected: "an array of non-empty strings", valid: isTextList },
  implementations: { expected: "an array of non-empty strings", valid: isTextList },
  tests: { expected: "an array of non-empty strings", valid: isTextList },
  exclude: { expected: "an array of non-empty strings", valid: isTextList },
  testAdapter: { expected: '"node:test" or "vitest"', valid: (value) => value === "node:test" || value === "vitest" },
  generatedFiles: { expected: "true or false", valid: (value) => typeof value === "boolean" },
  review: { expected: '"off", "warn" or "require"', valid: (value) => value === "off" || value === "warn" || value === "require" },
};

function validate(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["The configuration must be a JSON object."];
  const problems: string[] = [];
  if (!("version" in value)) problems.push('"version" is required and must be 1.');
  for (const [name, fieldValue] of Object.entries(value)) {
    const field = Object.hasOwn(fields, name) ? fields[name as keyof Config] : undefined;
    if (!field) problems.push(`Unknown field "${name}".`);
    else if (!field.valid(fieldValue)) problems.push(`"${name}" must be ${field.expected}.`);
  }
  return problems;
}
