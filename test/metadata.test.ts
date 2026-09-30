import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDocTags, parseInvariant, parseName, parseNames, tagKind } from "../src/metadata.ts";

test("a tag starts a line of the doc comment; the text runs until the next tag", () => {
  const comment = [
    "/**",
    " * Free text first, with an address like team@example.com and an inline @mention.",
    " *",
    " * @contract",
    " * @description Зберігає значення",
    " *   за ключем.",
    " * @invariant race Паралельні виклики",
    " *",
    " * не перевищують залишок.",
    "   @uses A, B",
    " * @param key See @link elsewhere",
    " */",
  ].join("\n");
  const tags = parseDocTags(comment, 100);
  assert.deepEqual(
    tags.map(({ name, text, suffix }) => [name, text + suffix]),
    [
      ["contract", ""],
      ["description", "Зберігає значення за ключем."],
      ["invariant", "race Паралельні виклики не перевищують залишок."],
      ["uses", "A, B"],
      ["param", "key See @link elsewhere"],
    ],
  );
  for (const tag of tags) assert.equal(comment.slice(tag.start - 100).startsWith(`@${tag.name}`), true, tag.name);
});

test("one-line doc comments and CRLF comments are read the same way", () => {
  assert.deepEqual(parseDocTags("/** @implements Store */", 0), [{ name: "implements", suffix: "", text: "Store", start: 4 }]);
  assert.deepEqual(parseDocTags("/**@tests Quota*/", 10), [{ name: "tests", suffix: "", text: "Quota", start: 13 }]);
  assert.deepEqual(parseDocTags("/**\r\n * @covers a\r\n *   b\r\n */", 0), [{ name: "covers", suffix: "", text: "a b", start: 8 }]);
  // A comment closed with `**/` does not leak a star into the last tag.
  assert.deepEqual(parseDocTags("/** @data\n * @description Id. **/", 0).map(({ name, text }) => [name, text]), [["data", ""], ["description", "Id."]]);
  assert.deepEqual(parseDocTags("/** @contract **/", 0).map(({ name, text }) => [name, text]), [["contract", ""]]);
  assert.deepEqual(parseDocTags("/** No tags at all. */", 0), []);
  // A tag name starts with a letter.
  assert.deepEqual(parseDocTags("/**\n * @123\n * @-x\n */", 0), []);
  // Punctuation glued to the name does not turn a tag into prose: the tag is read, with the glued part kept apart.
  assert.deepEqual(
    parseDocTags("/**\n * @invariant: race Text.\n * @uses, Foo\n * @contract.\n * @scope/package\n */", 0).map(({ name, suffix, text }) => [name, suffix, text]),
    [
      ["invariant", ":", "race Text."],
      ["uses", ",", "Foo"],
      ["contract", ".", ""],
      ["scope", "/package", ""],
    ],
  );
});

test("tag kinds are case-sensitive", () => {
  assert.deepEqual(
    ["contract", "covers", "final", "extendable", "param", "typeParam", "name", "open", "Contract", "todo"].map(tagKind),
    ["harness", "harness", "harness", "harness", "standard", "standard", "unsupported", "unsupported", "unknown", "unknown"],
  );
});

test("tag arguments", () => {
  assert.deepEqual(parseNames("Quota Sender"), ["Quota", "Sender"]);
  assert.deepEqual(parseNames("Quota, Sender,Quota"), ["Quota", "Sender"]);
  assert.deepEqual(parseNames("Надсилач, Квота_2 $x"), ["Надсилач", "Квота_2", "$x"]);
  assert.equal(parseNames(""), undefined);
  assert.equal(parseNames("Quota send-er"), undefined);

  assert.equal(parseName("Store"), "Store");
  assert.equal(parseName("Store Other"), undefined);
  assert.equal(parseName(""), undefined);

  assert.deepEqual(parseInvariant("sender-error При помилці Sender відхиляє виклик."), { id: "sender-error", text: "При помилці Sender відхиляє виклик." });
  for (const invalid of ["", "empty", "Empty Текст.", "1st Текст.", "two_words Текст."]) assert.equal(parseInvariant(invalid), undefined, invalid);
});
