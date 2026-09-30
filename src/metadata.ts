import { splitLines } from "./location.ts";

export interface DocTag {
  /** Tag name without the `@`; case-sensitive. */
  name: string;
  /** Characters glued to the name, as the `:` of `@invariant: id`; empty for a well-formed tag. */
  suffix: string;
  /** Text after the name, with continuation lines joined by a space. */
  text: string;
  /** Offset of the `@` in the file the comment comes from. */
  start: number;
}

/** The harness vocabulary. */
export const HARNESS_TAGS: ReadonlySet<string> = new Set([
  "contract",
  "data",
  "description",
  "uses",
  "invariant",
  "implements",
  "tests",
  "covers",
]);

/** Ordinary JSDoc tags that may appear next to harness tags. */
const STANDARD_TAGS: ReadonlySet<string> = new Set([
  "param",
  "returns",
  "return",
  "example",
  "deprecated",
  "remarks",
  "see",
  "throws",
  "typeParam",
  "template",
]);

/** Postponed features: accepting them silently would suggest they are enforced. */
const UNSUPPORTED_TAGS: ReadonlySet<string> = new Set(["name", "final", "extendable", "open"]);

export type TagKind = "harness" | "standard" | "unsupported" | "unknown";

export function tagKind(name: string): TagKind {
  if (HARNESS_TAGS.has(name)) return "harness";
  if (STANDARD_TAGS.has(name)) return "standard";
  return UNSUPPORTED_TAGS.has(name) ? "unsupported" : "unknown";
}

export const isDocComment = (comment: string) => comment.startsWith("/**") && comment.length > 4;

/**
 * Reads the tags of a `/** ... *\/` comment that starts at offset `start` of
 * its file. A tag begins a line, after the comment gutter; an `@` inside a
 * sentence is text. Lines that follow belong to the tag until the next tag.
 */
export function parseDocTags(comment: string, start: number): DocTag[] {
  const bodyStart = "/**".length;
  const tags: DocTag[] = [];
  // The comment may also be closed with `**/`.
  for (const line of splitLines(comment.slice(bodyStart, -"*/".length).replace(/\*+$/, ""))) {
    const gutter = /^\s*\*?\s*/.exec(line.text)![0].length;
    const content = line.text.slice(gutter).trimEnd();
    // A line that starts with `@name` is a tag whatever follows: `@invariant: id` is a malformed tag, not prose.
    const tag = /^@([A-Za-z][A-Za-z0-9-]*)(\S*)/.exec(content);
    if (tag) {
      tags.push({ name: tag[1], suffix: tag[2], text: content.slice(tag[0].length).trim(), start: start + bodyStart + line.start + gutter });
    } else if (content !== "" && tags.length > 0) {
      const current = tags.at(-1)!;
      current.text = current.text === "" ? content : `${current.text} ${content}`;
    }
  }
  return tags;
}

const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;
const INVARIANT_ID = /^[a-z][a-z0-9-]*$/;

/** The names of a `@uses A B` or `@uses A, B` tag; undefined when it is empty or has a non-identifier. */
export function parseNames(text: string): string[] | undefined {
  const names = text.split(/[\s,]+/).filter((name) => name !== "");
  return names.length > 0 && names.every((name) => IDENTIFIER.test(name)) ? [...new Set(names)] : undefined;
}

/** The single name of `@implements A` or `@tests A`. */
export function parseName(text: string): string | undefined {
  return IDENTIFIER.test(text) ? text : undefined;
}

/** `@invariant id text`: a short id, then a non-empty text. */
export function parseInvariant(text: string): { id: string; text: string } | undefined {
  const parts = /^(\S+)\s+(\S.*)$/s.exec(text);
  return parts && INVARIANT_ID.test(parts[1]) ? { id: parts[1], text: parts[2] } : undefined;
}
