import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { codeFingerprintText } from "../src/review-fingerprint.ts";

const compilers = [ts, ts5 as unknown as typeof ts];
const normalize = (compiler: typeof ts, text: string, kind = compiler.ScriptKind.TS) => codeFingerprintText(compiler, compiler.createSourceFile("source.ts", text, compiler.ScriptTarget.Latest, true, kind));

/** @tests Cli
 * @covers review-code-trivia */
test("ordinary comments and spacing disappear from code fingerprints, including empty bodies and literal config objects", () => {
  for (const compiler of compilers) {
    for (const [before, after] of [
      ["export const limits = { read: 300 };", "/** Explanatory heading. */\nexport  const limits = {\n  // Read budget.\n  read: 300\n};"],
      ["export function run() {}", "export function run() { /* Nothing to do. */ }"],
      ["/** @implements Port */\nexport class Impl {}", "/** @implements Port */\n\n  export class Impl {}"],
      ["/** @tests Port */\ndescribe('port', () => {});", "/** @tests Port */\n\n\ndescribe('port', () => {});"],
      ["/** @covers empty */\ntest('empty', () => {});", "/** @covers empty */\n\n  test('empty', () => {});"],
      ["/** @implements Port */\nexport class Impl { run() { return 1; } }", "/** @implements Port */\nexport class Impl {\n  /** Return the result. */\n  run() {\n    // A useful explanation.\n    return 1;\n  }\n}"],
      ["test('works', () => { assert.ok(true); });", "// Before.\ntest( 'works', () => {\n /* Why this matters. */ assert.ok( true );\n}); // After."],
    ]) assert.equal(normalize(compiler, before), normalize(compiler, after), after);
  }
});

/** @tests Cli
 * @covers review-stale review-code-trivia */
test("syntax, literal contents and automatic semicolon insertion remain fingerprinted", () => {
  for (const compiler of compilers) {
    for (const [before, after] of [
      ["const limit = 300;", "const limit = 301;"],
      ["function f() { return value; }", "function f() { return\nvalue; }"],
      ["const text = '// comment';", "const text = '// edited';"],
      ["const pattern = /a\\/\\/b/;", "const pattern = /a\\/\\/c/;"],
      ["const text = `a ${value} b`;", "const text = `a ${value}  b`;"],
      ["assert.equal(result, true);", "assert.equal(result, false);"],
      ["const f = () => ({ a: 1 });", "const f = () => { a: 1 };"],
    ]) assert.notEqual(normalize(compiler, before), normalize(compiler, after), after);
    assert.notEqual(normalize(compiler, "const view = <div> a b </div>;", compiler.ScriptKind.TSX), normalize(compiler, "const view = <div> a  b </div>;", compiler.ScriptKind.TSX));
  }
});

/** @tests Cli
 * @covers review-stale review-code-trivia */
test("annotations, tool directives and their attachment remain fingerprinted", () => {
  for (const compiler of compilers) {
    for (const directive of ["/** @covers empty */", "// @ts-ignore", "// @ts-expect-error", "// @ts-nocheck", "/// <reference types='node' />", "/* istanbul ignore next */", "/* c8 ignore next */", "/* v8 ignore next */", "/* node:coverage ignore next */", "/* node:coverage ignore next 2 */", "/* node:coverage disable */", "/* node:coverage enable */", "/* eslint-disable */", "/* @__PURE__ */", "/* webpackChunkName: 'chunk' */", "//# sourceMappingURL=code.map"]) {
      const before = `${directive}\nconst a = 1;\nconst b = 2;`;
      assert.notEqual(normalize(compiler, before), normalize(compiler, "const a = 1;\nconst b = 2;"), directive);
      assert.notEqual(normalize(compiler, before), normalize(compiler, `const a = 1;\n${directive}\nconst b = 2;`), directive);
    }
    assert.notEqual(normalize(compiler, "/** @covers empty */\ntest('works', () => {});"), normalize(compiler, "/** @covers consume */\ntest('works', () => {});"));
    assert.notEqual(normalize(compiler, "/** @implements Port */\nexport class Impl {}"), normalize(compiler, "/** @implements Port */\n/* Detaches the tag. */\nexport class Impl {}"));
    assert.notEqual(normalize(compiler, "// @ts-ignore\nconst a = broken; const b = broken;"), normalize(compiler, "// @ts-ignore\nconst a = broken;\nconst b = broken;"));
    const coverage = "/* node:coverage ignore next */\nconst a = 1; const b = 2;";
    assert.notEqual(normalize(compiler, coverage), normalize(compiler, coverage.replace("*/\n", "*/\n\n")));
    assert.notEqual(normalize(compiler, coverage), normalize(compiler, coverage.replace("; const b", ";\nconst b")));
    assert.notEqual(normalize(compiler, coverage), normalize(compiler, coverage.replace("ignore next */", "ignore next 2 */")));
  }
});

test("unparseable source keeps its raw text instead of trusting a recovered tree", () => {
  for (const compiler of compilers) assert.notEqual(normalize(compiler, "const = ; // first"), normalize(compiler, "const = ; // second"));
});

/** @tests Cli
 * @covers review-code-trivia */
test("file-wide directives remain material of a declaration below unrelated code", () => {
  for (const compiler of compilers) {
    const selected = (text: string) => {
      const source = compiler.createSourceFile("source.ts", text, compiler.ScriptTarget.Latest, true);
      return codeFingerprintText(compiler, source.statements.at(-1)!);
    };
    for (const directive of ["// @ts-nocheck", "// @ts-check", "/** @jsxImportSource custom */", "/// <reference types='node' />", "/* node:coverage disable */", "/* node:coverage enable */", "/* node:coverage ignore next 2 */"]) {
      assert.notEqual(selected(`${directive}\nconst unrelated = 1;\nexport const run = () => 1;`), selected("const unrelated = 1;\nexport const run = () => 1;"), directive);
    }
  }
});

/** @tests Cli
 * @covers review-code-trivia review-stale */
test("moving a compiler pragma past unselected code changes the selected fingerprint and emitted JSX", () => {
  for (const compiler of compilers) {
    const declaration = "export function view() { return <div />; }";
    const selected = (text: string) => {
      const source = compiler.createSourceFile("source.tsx", text, compiler.ScriptTarget.Latest, true, compiler.ScriptKind.TSX);
      return codeFingerprintText(compiler, source.statements.at(-1)!);
    };
    const before = `/** @jsx h */\nconst unused = 1;\n${declaration}`;
    const after = `const unused = 1;\n/** @jsx h */\n${declaration}`;
    const emit = (text: string) => compiler.transpileModule(text, { fileName: "source.tsx", compilerOptions: { jsx: compiler.JsxEmit.React } }).outputText;
    assert.match(emit(before), /return h\(/);
    assert.match(emit(after), /return React.createElement\(/);
    assert.notEqual(selected(before), selected(after));
    assert.equal(selected(before), selected(`// Explanation.\n\n${before}`));
    for (const directive of ["// @ts-nocheck", "// @ts-check", "/** @jsxImportSource custom */", "/// <reference types='node' />"]) {
      assert.notEqual(selected(`${directive}\nconst unused = 1;\n${declaration}`), selected(`const unused = 1;\n${directive}\n${declaration}`), directive);
    }
  }
});
