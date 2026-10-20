import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DESIGN_SUFFIX } from "./discovery.ts";
import { stripBom } from "./location.ts";

/** The suffix of a draft: `quota.cage.draft.mdx` proposes the next `quota.cage.mdx` of the same directory. */
export const DRAFT_SUFFIX = ".cage.draft.mdx";

/** The draft of an active design path, and the reverse: one is derived from the other by the suffix, never stored apart. */
export const draftPathOf = (target: string) => `${target.slice(0, -DESIGN_SUFFIX.length)}${DRAFT_SUFFIX}`;
export const targetPathOf = (draft: string) => `${draft.slice(0, -DRAFT_SUFFIX.length)}${DESIGN_SUFFIX}`;

/**
 * A path as given on the command line, relative to the project root like the paths of the configuration, as a
 * project-relative POSIX path; or what is wrong with it. Absolute paths, `..` and a name without the suffix are
 * refused before anything is read.
 */
export function projectPathArgument(argument: string, suffix: typeof DESIGN_SUFFIX | typeof DRAFT_SUFFIX): string | { problem: string } {
  const what = suffix === DRAFT_SUFFIX ? "a draft (*.cage.draft.mdx)" : "a design document (*.cage.mdx)";
  if (argument.trim() === "") return { problem: `needs the path of ${what}, relative to the project root.` };
  if (path.isAbsolute(argument) || path.posix.isAbsolute(argument) || /^[A-Za-z]:/.test(argument)) return { problem: `"${argument}" is absolute; give the path relative to the project root.` };
  const segments = argument.split(/[\\/]/);
  if (segments.includes("..")) return { problem: `"${argument}" leaves its directory with ".."; give the path inside the project root.` };
  if (/[\0-\x1f]|\*\//.test(argument)) return { problem: `"${argument}" has characters a draft header cannot hold.` };
  const file = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  const name = path.posix.basename(file);
  if (!name.endsWith(suffix) || name === suffix) {
    const hint = suffix === DESIGN_SUFFIX && name.endsWith(DRAFT_SUFFIX) ? `; ${file} is a draft, its design is ${targetPathOf(file)}` : suffix === DRAFT_SUFFIX && name.endsWith(DESIGN_SUFFIX) ? `; the draft of ${file} is ${draftPathOf(file)}` : "";
    return { problem: `"${argument}" is not ${what}${hint}.` };
  }
  return file;
}

/** What is at a project path: nothing, a regular file, or something cage does not follow or overwrite. */
export type PathState = "missing" | "file" | { problem: string };

/**
 * Looks at a project-relative path without following links: every directory on the way below the root must be a
 * real directory, so that nothing read or written lies outside the project, and the file itself a regular file.
 * `discoverDesigns` does not follow links either, so a document behind one would never be a design.
 */
export function inspectPath(root: string, file: string): PathState {
  const segments = file.split("/");
  for (let depth = 1; depth <= segments.length; depth++) {
    const partial = segments.slice(0, depth).join("/");
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(root, partial));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      return { problem: `${partial} cannot be read: ${(cause as Error).message}` };
    }
    if (stat.isSymbolicLink()) return { problem: `${partial} is a symbolic link; cage does not follow it` };
    if (depth < segments.length && !stat.isDirectory()) return { problem: `${partial} is not a directory` };
    if (depth === segments.length && !stat.isFile()) return { problem: `${file} is not a regular file` };
  }
  return "file";
}

/** The digest a draft records of its target: SHA-256 of the text without a byte order mark and with `\n` line endings. */
export const digestOf = (text: string) => `sha256:${crypto.createHash("sha256").update(stripBom(text).replace(/\r\n?/g, "\n")).digest("hex")}`;

/** A draft as read: the target it names, the digest of the target it was created from (null: there was none), and its content without the header. */
export interface ParsedDraft {
  target: string;
  base: string | null;
  content: string;
  /** Lines the header takes: a line of the content is this many lines further down in the draft. */
  headerLines: number;
}

const HEADER_VERSION = 1;
const HEADER = /^\{\/\* cage draft v1\r?\ntarget: ([^\r\n]+)\r?\nbase: (sha256:[0-9a-f]{64}|null)\r?\n\*\/\}\r?\n/;

/** The header of a draft: an MDX comment, so the draft stays a readable document. */
export function formatDraft(target: string, base: string | null, content: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return [`{/* cage draft v${HEADER_VERSION}`, `target: ${target}`, `base: ${base ?? "null"}`, "*/}", content].join(newline);
}

/** A draft's header and content, or what is wrong with the header. The header is strict: anything else is no permission to activate. */
export function parseDraft(text: string): ParsedDraft | { problem: string } {
  const source = stripBom(text);
  const found = HEADER.exec(source);
  if (!found) {
    const version = /^\{\/\* cage draft v(\S+)/.exec(source)?.[1];
    if (version !== undefined && version !== String(HEADER_VERSION)) return { problem: `header version ${version} is not supported; this cage reads v${HEADER_VERSION}` };
    return { problem: `no draft header: the file must start with "{/* cage draft v${HEADER_VERSION}", "target: <path>", "base: sha256:<64 hex>|null" and "*/}", one a line, as cage draft create writes them` };
  }
  return { target: found[1], base: found[2] === "null" ? null : found[2], content: source.slice(found[0].length), headerLines: found[0].split("\n").length - 1 };
}
