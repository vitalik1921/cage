import crypto from "node:crypto";
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
  const invalid = (message: string) => ({ entries: [], diagnostics: [{ code: "E_CONFIG", severity: "error" as const, message: `${label} not usable: ${message}`, file }] });
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

/** A temporary file of ours that could not be removed after a write: an absolute path, and why. */
export interface Leftover {
  file: string;
  message: string;
}

/** A write that failed before anything was committed; `leftover` is a temporary file of its own it could not remove. */
export class FileWriteError extends Error {
  readonly leftover?: Leftover;
  constructor(cause: unknown, leftover?: Leftover) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    if (leftover) this.leftover = leftover;
  }
}

/** Removes a temporary file this process created; what is wrong when it cannot. */
function discard(temporary: string): Leftover | undefined {
  try {
    fs.rmSync(temporary, { force: true });
    return undefined;
  } catch (cause) {
    return { file: temporary, message: (cause as Error).message };
  }
}

/**
 * Writes `text` to a new temporary file next to `file` and returns its path. The name is unique and opened with `wx`,
 * so the file is this call's own: a file someone else left under a similar name is never written or removed. When
 * the write fails, the temporary file is removed again.
 */
function writeTemporary(file: string, text: string): string {
  for (let attempt = 1; ; attempt++) {
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    let descriptor: number;
    try {
      descriptor = fs.openSync(temporary, "wx");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST" && attempt < 10) continue;
      throw new FileWriteError(cause);
    }
    try {
      try {
        fs.writeFileSync(descriptor, text);
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (cause) {
      throw new FileWriteError(cause, discard(temporary));
    }
    return temporary;
  }
}

/**
 * Creates a file that must not exist yet, whole or not at all: the text goes to a temporary file of ours that is then
 * linked under the name, which fails when anything, a dangling link included, is there (`created: false`). Once the
 * link exists the file is created, whatever follows. A temporary file that cannot be removed is reported as
 * `leftover`, not as a failure. A failure before that throws a `FileWriteError`, and the name stays as it was.
 */
export function createFileExclusively(file: string, text: string): { created: boolean; leftover?: Leftover } {
  const temporary = writeTemporary(file, text);
  try {
    fs.linkSync(temporary, file);
  } catch (cause) {
    const leftover = discard(temporary);
    if ((cause as NodeJS.ErrnoException).code === "EEXIST") return leftover ? { created: false, leftover } : { created: false };
    throw new FileWriteError(cause, leftover);
  }
  const leftover = discard(temporary);
  return leftover ? { created: true, leftover } : { created: true };
}

/**
 * Replaces a record file atomically, creating its directory: readers see the old or the new text, never a partial
 * one. The rename is the commit; a failure before it throws a `FileWriteError` and leaves the file as it was.
 */
export function writeRecordFile(file: string, text: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (cause) {
    throw new FileWriteError(cause);
  }
  const temporary = writeTemporary(file, text);
  try {
    fs.renameSync(temporary, file);
  } catch (cause) {
    throw new FileWriteError(cause, discard(temporary));
  }
}
