import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { Diagnostic } from "../src/diagnostic.ts";
import { readImplementations } from "../src/implementations.ts";
import ts from "typescript";
import ts5 from "typescript-5";
import { checkLinking, cli, contract, designProject, inFile, mdx, writeFile } from "./helpers.ts";

const STORE = contract("Store", "get(key: string): string;", "@invariant hit Повертає значення.");
const IMPLEMENTATION = "/** @implements Store */\nexport class MemoryStore {\n  get(key: string): string {\n    return key;\n  }\n}\n";
const TESTS = ['import { describe, it } from "node:test";', "/** @tests Store */", 'describe("Store", () => {', "  /** @covers hit */", '  it("hit", () => { return; });', "});", ""].join("\n");

/** A module `src/m` with the Store contract, its one implementation and test, and the given extra files. */
function project(t: TestContext, files: Record<string, string>): string {
  return designProject(t, { m: mdx(STORE) }, { "src/m/memory-store.ts": IMPLEMENTATION, "src/m/store.test.ts": TESTS, ...files });
}

/** The CLI under `coverage: "require"`, with the project's own TypeScript being `compiler` from this repository. */
function requireCheck(root: string, compiler: "typescript-5" | "typescript") {
  writeFile(root, ".cage/config.json", JSON.stringify({ version: 1, coverage: "require" }));
  fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  const result = cli(root, "check", "--format", "json");
  const parsed = JSON.parse(result.stdout) as { diagnostics: Diagnostic[] };
  return { code: result.code, stdout: result.stdout, gaps: parsed.diagnostics.filter(({ code }) => code.endsWith("NOT_DESIGNED")).map(({ code, message, file, line, column }) => ({ code, message, file, line, column })) };
}

const LOCAL = [
  "class Extra {",
  "  extra(): void {}",
  "}",
  "function handle(): void {}",
  "function overloaded(input: string): string;",
  "function overloaded(input: string): string {",
  "  return input;",
  "}",
  "const helper = (): void => {}, LIMIT = 300;",
  "const config = { limit: 300 };",
  "export { Extra, handle as handler, overloaded, helper as one, helper as two, LIMIT, config };",
  "",
].join("\n");

/** @tests Cli
 * @covers design-coverage */
test("a local export list needs design coverage like an exported declaration, on TS 5 and 6", (t) => {
  for (const compiler of ["typescript-5", "typescript"] as const) {
    const listed = project(t, { "src/m/listed.ts": LOCAL });
    const result = requireCheck(listed, compiler);
    assert.equal(result.code, 1, result.stdout);
    // Once per declaration, where it is declared; a renamed or twice-aliased export is still one gap, and the scalar stays exempt.
    assert.deepEqual(result.gaps, [
      { code: "E_NOT_DESIGNED", message: "class Extra in src/m", ...inFile(listed, "src/m/listed.ts", "Extra") },
      { code: "E_NOT_DESIGNED", message: "function handle in src/m", ...inFile(listed, "src/m/listed.ts", "handle") },
      { code: "E_NOT_DESIGNED", message: "function overloaded in src/m", ...inFile(listed, "src/m/listed.ts", "overloaded(input: string): string {") },
      { code: "E_NOT_DESIGNED", message: "const helper in src/m", ...inFile(listed, "src/m/listed.ts", "helper") },
      { code: "E_NOT_DESIGNED", message: "const config in src/m", ...inFile(listed, "src/m/listed.ts", "config") },
    ]);

    // Direct control: the same code exported in place fails the same way.
    const direct = project(t, { "src/m/direct.ts": "export class Extra {\n  extra(): void {}\n}\n" });
    assert.deepEqual(requireCheck(direct, compiler).gaps, [{ code: "E_NOT_DESIGNED", message: "class Extra in src/m", ...inFile(direct, "src/m/direct.ts", "Extra") }]);
    const viaList = project(t, { "src/m/direct.ts": "class Extra {\n  extra(): void {}\n}\nexport { Extra };\n" });
    assert.deepEqual(requireCheck(viaList, compiler).gaps, [{ code: "E_NOT_DESIGNED", message: "class Extra in src/m", ...inFile(viaList, "src/m/direct.ts", "Extra") }]);
  }
});

/** @tests Cli
 * @covers design-coverage */
test("type-only, imported, default and unexported names in a list need no design", (t) => {
  const root = project(t, {
    "src/m/other.ts": "export const LIMIT = 300;\n",
    "src/m/shared.ts": "export const SCALAR = 1;\n",
    "src/m/listed.ts": [
      'import { LIMIT } from "./other.ts";',
      "class TypeOnly {}",
      "class InlineTypeOnly {}",
      "class Fallback {}",
      "class Hidden {}",
      "declare class Ambient {}",
      "export type { TypeOnly };",
      "export { type InlineTypeOnly, LIMIT, Fallback as default, Ambient };",
      'export { SCALAR } from "./shared.ts";',
      'export { SCALAR as RENAMED } from "./shared.ts";',
      "void Hidden;",
      "",
    ].join("\n"),
  });
  for (const compiler of ["typescript-5", "typescript"] as const) {
    const result = requireCheck(root, compiler);
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.gaps, []);
  }
});

/** @tests Cli
 * @covers design-coverage */
test("a design-tagged local class in an export list stays unsupported and is not reported as undesigned", (t) => {
  const root = project(t, { "src/m/local.ts": "/** @implements Store */\nclass LocalStore {\n  get(key: string): string {\n    return key;\n  }\n}\nexport { LocalStore };\n" });
  const { diagnostics, linking } = checkLinking(root);
  assert.deepEqual(
    diagnostics.map(({ code, file, line, column }) => ({ code, file, line, column })),
    [{ code: "E_UNSUPPORTED_DECLARATION", ...inFile(root, "src/m/local.ts", "@implements") }],
  );
  assert.deepEqual(linking.implementations.map(({ contract, name }) => [contract, name]), [["Store", "MemoryStore"]]);
});

/** @tests Cli
 * @covers design-coverage */
test("export lists are read the same by the TS 5 and 6 compiler APIs", () => {
  for (const compiler of [ts5 as unknown as typeof ts, ts]) {
    const source = compiler.createSourceFile("listed.ts", LOCAL, compiler.ScriptTarget.Latest, true);
    const read = readImplementations(compiler, source, "listed.ts", false);
    assert.deepEqual(read.exported.map(({ name, kind }) => `${kind} ${name}`), ["class Extra", "function handle", "function overloaded", "const helper", "const config"]);
    assert.deepEqual(read.found, []);
  }
});
