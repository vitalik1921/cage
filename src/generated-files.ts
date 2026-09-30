import fs from "node:fs";
import { GENERATED_HEADER } from "./extraction.ts";
import { stripBom } from "./location.ts";

export type OutputState = "current" | "missing" | "stale" | "conflict";

/**
 * Compares a generated file on disk with the text extracted from the current
 * MDX, ignoring CRLF/LF differences. A path that is not a regular file that
 * starts with the ownership header is not ours to write: "conflict".
 */
export function inspectOutput(file: string, expected: string): OutputState {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(file);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw cause;
  }
  // A symbolic link or a directory: writing must not pass through it.
  if (!stats.isFile()) return "conflict";
  const text = stripBom(fs.readFileSync(file, "utf8")).replaceAll("\r\n", "\n");
  if (!text.startsWith(GENERATED_HEADER)) return "conflict";
  return text === expected ? "current" : "stale";
}

/** Replaces the file atomically: readers see the old or the new text, never a partial one. */
export function writeOutput(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (cause) {
    fs.rmSync(temporary, { force: true });
    throw cause;
  }
}
