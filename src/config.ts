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
  /** How `check` treats a contract without a fresh recorded review: not at all, as a warning, or as an error. */
  review: "off" | "warn" | "require";
  /** How `check` treats exported code of a designed module that nothing marks `@implements`: not at all, as a warning, or as an error. */
  coverage: "off" | "warn" | "require";
  /** How far a review's fingerprint follows the local files that implementations and tests import. */
  reviewDependencies: ReviewDependencies;
  /**
   * How many diagnostics the report of `check` and the feedback of `gate` show at most; the rest is counted by code. What
   * matters most is kept: configuration and environment errors, then errors, then missing or outdated reviews. `"all"`
   * shows every one.
   */
  maxDiagnostics: number | "all";
}

/**
 * The bounds of the dependency part of a review's fingerprint. `depth`: import levels followed from an
 * implementation or test file (1 = its direct imports). `maxFiles`: dependency files fingerprinted per
 * contract. `exclude`: glob patterns of files neither fingerprinted nor followed, on top of `exclude`.
 * Whatever lies beyond the bounds is reported, never silently dropped.
 */
export interface ReviewDependencies {
  depth: number;
  maxFiles: number;
  exclude: string[];
}

export const DEFAULT_CONFIG_FILE = ".cage/config.json";

export const defaultConfig: Config = {
  version: 1,
  tsconfig: "tsconfig.json",
  designs: ["src/**/*.cage.mdx"],
  implementations: ["src/**/*.ts"],
  tests: ["src/**/*.test.ts", "tests/**/*.test.ts"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/coverage/**"],
  testAdapter: "node:test",
  review: "warn",
  coverage: "warn",
  reviewDependencies: { depth: 3, maxFiles: 40, exclude: [] },
  maxDiagnostics: 50,
};

/** The bound of `maxDiagnostics`: a report longer than this is for a machine, which reads the JSON with `"all"`. */
export const MAX_DIAGNOSTICS_LIMIT = 10000;

/** `maxDiagnostics` as written in the configuration or on the command line: a whole number from 0 to the bound, or "all". */
export const isMaxDiagnostics = (value: unknown): value is Config["maxDiagnostics"] => value === "all" || (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DIAGNOSTICS_LIMIT);

export interface LoadedConfig {
  config: Config;
  diagnostics: Diagnostic[];
}

/**
 * Loads `configPath` (relative to `root`), or `.cage/config.json` when it
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
    return { config: defaultConfig, diagnostics: [error(`cannot read the configuration: ${(cause as Error).message}`)] };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return { config: defaultConfig, diagnostics: [error(`invalid JSON: ${(cause as Error).message}`)] };
  }

  const problems = validate(value);
  if (problems.length > 0) return { config: defaultConfig, diagnostics: problems.map(error) };
  const given = value as Partial<Config>;
  // The bounds are merged field by field: a configuration may raise one and keep the others.
  return { config: { ...defaultConfig, ...given, reviewDependencies: { ...defaultConfig.reviewDependencies, ...given.reviewDependencies } }, diagnostics: [] };
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
  review: { expected: '"off", "warn" or "require"', valid: (value) => value === "off" || value === "warn" || value === "require" },
  coverage: { expected: '"off", "warn" or "require"', valid: (value) => value === "off" || value === "warn" || value === "require" },
  reviewDependencies: {
    expected: 'an object with "depth" (0–10), "maxFiles" (0–1000) and "exclude" (an array of non-empty strings), each optional',
    valid: (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const { depth, maxFiles, exclude, ...rest } = value as Record<string, unknown>;
      const whole = (number: unknown, max: number) => number === undefined || (Number.isInteger(number) && (number as number) >= 0 && (number as number) <= max);
      return Object.keys(rest).length === 0 && whole(depth, 10) && whole(maxFiles, 1000) && (exclude === undefined || isTextList(exclude));
    },
  },
  maxDiagnostics: { expected: `a whole number from 0 to ${MAX_DIAGNOSTICS_LIMIT}, or "all"`, valid: isMaxDiagnostics },
};

function validate(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not a JSON object"];
  const problems: string[] = [];
  if (!("version" in value)) problems.push('"version" must be 1');
  for (const [name, fieldValue] of Object.entries(value)) {
    const field = Object.hasOwn(fields, name) ? fields[name as keyof Config] : undefined;
    if (!field) problems.push(`unknown field "${name}"`);
    else if (!field.valid(fieldValue)) problems.push(`"${name}" must be ${field.expected}`);
  }
  return problems;
}
