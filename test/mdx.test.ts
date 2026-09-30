import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDesignMdx, type DesignBlock } from "../src/mdx.ts";
import { doc } from "./helpers.ts";

const codes = (source: string) =>
  parseDesignMdx(source, "design.mdx").diagnostics.map(({ code, line, column }) => ({ code, line, column }));

const textOf = (block: DesignBlock) => block.lines.map((line) => line.text).join("\n");

test("selects top-level ts design blocks in document order and leaves other code as examples", () => {
  const source = doc(
    "# Title",
    "",
    "```ts design",
    "export type A = string;",
    "```",
    "",
    "```ts",
    "/** @contract */",
    "export interface Fake { not valid TypeScript",
    "```",
    "",
    "```typescript",
    "/** @covers x */",
    "```",
    "",
    "```ts design-ish",
    "export type Ignored = 1;",
    "```",
    "",
    "~~~ts   design  ",
    "export type B = A;",
    "~~~",
  );
  const { blocks, diagnostics } = parseDesignMdx(source, "design.mdx");
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(blocks.map(textOf), ["export type A = string;", "export type B = A;"]);
  assert.deepEqual(
    blocks.map((block) => block.order),
    [0, 1],
  );
});

test("block lines keep their text and point at their place in the document", () => {
  const source = ["# Title", "", "```ts design", "", "  export type A =", "\tstring; // \0", "", "", "```", ""].join("\r\n");
  const { blocks, diagnostics } = parseDesignMdx(source, "design.mdx");
  assert.deepEqual(diagnostics, []);
  // Leading empty lines and indentation stay, trailing empty lines go; the parser turns NUL into U+FFFD.
  assert.deepEqual(
    blocks[0].lines.map((line) => line.text),
    ["", "  export type A =", `\tstring; // ${String.fromCharCode(0xfffd)}`],
  );
  assert.deepEqual(
    blocks[0].lines.map((line) => line.sourceStart),
    [source.indexOf("\r\n  export"), source.indexOf("  export"), source.indexOf("\tstring")],
  );
});

test("rejects design blocks nested in lists, blockquotes, JSX or indented", () => {
  const source = doc(
    "- item",
    "",
    "  ```ts design",
    "  export type A = string;",
    "  ```",
    "",
    "> ```ts design",
    "> export type B = string;",
    "> ```",
    "",
    "<Note>",
    "",
    "```ts design",
    "export type C = string;",
    "```",
    "",
    "</Note>",
    "",
    "   ```ts design",
    "export type D = string;",
    "   ```",
  );
  assert.deepEqual(codes(source), [
    { code: "E_DESIGN_BLOCK_LOCATION", line: 3, column: 3 },
    { code: "E_DESIGN_BLOCK_LOCATION", line: 7, column: 3 },
    { code: "E_DESIGN_BLOCK_LOCATION", line: 13, column: 1 },
    { code: "E_DESIGN_BLOCK_LOCATION", line: 19, column: 4 },
  ]);
});

test("reserved design meta on another language is an error", () => {
  const source = doc("```typescript design", "export type A = string;", "```", "", "```js design", "x", "```");
  assert.deepEqual(codes(source), [
    { code: "E_DESIGN_BLOCK_MARKER", line: 1, column: 1 },
    { code: "E_DESIGN_BLOCK_MARKER", line: 5, column: 1 },
  ]);
});

test("a document needs a non-empty design block", () => {
  assert.deepEqual(codes(doc("# Prose only", "", "```ts", "export type A = string;", "```")), [
    { code: "E_DESIGN_BLOCK_MISSING", line: undefined, column: undefined },
  ]);
  for (const body of [[], [""], ["  ", ""]]) {
    assert.deepEqual(codes(doc("# Empty", "", "```ts design", ...body, "```")), [{ code: "E_DESIGN_BLOCK_EMPTY", line: 3, column: 1 }]);
  }
  assert.deepEqual(codes(doc("# Unclosed", "", "```ts design")), [{ code: "E_DESIGN_BLOCK_EMPTY", line: 3, column: 1 }]);
});

test("MDX syntax errors carry the source location", () => {
  const cases: [string, { line: number; column: number }][] = [
    [doc("# Title", "", "Text {1 +} more."), { line: 3, column: 10 }],
    [doc("# Title", "", "<Note>", "", "text"), { line: 3, column: 1 }],
    // Reported at the paragraph; the message carries the position of the tag itself.
    [doc("# Title", "", "Returns Promise<string> here."), { line: 3, column: 1 }],
    [doc("# Title", "", "<a>text</b>"), { line: 3, column: 8 }],
  ];
  for (const [source, position] of cases) {
    const { blocks, diagnostics } = parseDesignMdx(`${source}\n\n\`\`\`ts design\nexport type A = string;\n\`\`\`\n`, "design.mdx");
    assert.deepEqual(blocks, []);
    assert.deepEqual(codes(`${source}\n`), [{ code: "E_MDX_SYNTAX", ...position }], source);
    assert.equal(diagnostics.length, 1);
  }
});
