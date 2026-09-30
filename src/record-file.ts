import fs from "node:fs";
import path from "node:path";
import type { Diagnostic } from "./diagnostic.ts";
import { stripBom } from "./location.ts";

/** The entries of a JSON record's text, or what is wrong with it. `parse` judges the parsed value. */
export function parseRecordText<T>(text: string, parse: (value: unknown) => T[] | string): T[] | string {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch (cause) {
    return (cause as Error).message;
  }
  return parse(value);
}

/**
 * Reads a JSON record that a harness command writes, such as the lock or
 * the review file: none when it does not exist yet, a configuration error
 * when it cannot be read or is not what the command writes.
 */
export function readRecordFile<T>(root: string, file: string, label: string, parse: (value: unknown) => T[] | string): { entries: T[]; diagnostics: Diagnostic[] } {
  const invalid = (message: string) => ({ entries: [], diagnostics: [{ code: "E_CONFIG", severity: "error" as const, message: `The ${label} is not usable: ${message}`, file }] });
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), "utf8");
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? { entries: [], diagnostics: [] } : invalid((cause as Error).message);
  }
  const parsed = parseRecordText(text, parse);
  return typeof parsed === "string" ? invalid(parsed) : { entries: parsed, diagnostics: [] };
}

export const isText = (value: unknown): value is string => typeof value === "string";
