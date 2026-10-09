import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { dependencySlices } from "../src/review-slice.ts";

const compilers = [ts, ts5 as unknown as typeof ts];
function fingerprint(compiler: typeof ts, code: string, body = "return config.used;", extra: Record<string, string> = {}) {
  const sources = new Map(Object.entries({ "root.ts": `import { config } from 'dep'; export function run() { ${body} }`, "dep.ts": code, ...extra }).map(([file, text]) => [file, compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true)]));
  const root = sources.get("root.ts")!;
  const sliced = dependencySlices(compiler, sources, [{ file: "root.ts", nodes: [root.statements[1]] }], ["dep.ts", ...Object.keys(extra)], new Set(), (specifier) => `${specifier}.ts`);
  return JSON.stringify([...sliced.dependencies].map(([file, slice]) => [file, slice?.fingerprintText ?? sources.get(file)!.text]));
}

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("static object fields retain relevant initializers and ignore independent siblings on TS5/6", () => {
  for (const compiler of compilers) {
    const code = "const base = 10; export const config = { used: base, spare: 20 } as const;";
    for (const access of ["config.used", "config['used']"]) {
      const before = fingerprint(compiler, code, `return ${access};`);
      assert.equal(before, fingerprint(compiler, code.replace("spare: 20", "spare: 30"), `return ${access};`));
      assert.notEqual(before, fingerprint(compiler, code.replace("base = 10", "base = 11"), `return ${access};`));
      assert.notEqual(before, fingerprint(compiler, code.replace("used: base", "used: 11"), `return ${access};`));
    }
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("object methods follow explicit sibling calls and their helpers", () => {
  for (const compiler of compilers) {
    const code = "function helper() { return 1; } export const config = { used() { return config.other(); }, other() { return helper(); }, spare() { return 20; } };";
    const before = fingerprint(compiler, code, "return config.used();");
    assert.equal(before, fingerprint(compiler, code.replace("return 20", "return 30"), "return config.used();"));
    assert.notEqual(before, fingerprint(compiler, code.replace("return helper()", "return 2"), "return config.used();"));
    assert.notEqual(before, fingerprint(compiler, code.replace("return 1", "return 2"), "return config.used();"));
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-fallback */
test("methods with nested mutable state retain mutators and escaped state on TS5/6", () => {
  for (const compiler of compilers) {
    for (const update of [
      "config.values.splice(0, 1, 2);",
      "config['values']['splice'](0, 1, 2);",
      "(config.values as number[]).splice(0, 1, 2);",
      "const values = config.values; values.splice(0, 1, 2);",
      "Array.prototype.splice.call(config.values, 0, 1, 2);",
    ]) {
      const code = `export const config = { values: [1], used() { return config.values[0]; }, update() { ${update} } };`;
      assert.notEqual(fingerprint(compiler, code, "return config.used();"), fingerprint(compiler, code.replace("1, 2", "1, 3"), "return config.used();"), `${compiler.version}: ${update}`);
    }
    const nested = "export const config = { state: { values: [1] }, used() { return config.state.values[0]; }, update() { config.state.values.splice(0, 1, 2); } };";
    assert.notEqual(fingerprint(compiler, nested, "return config.used();"), fingerprint(compiler, nested.replace("1, 2", "1, 3"), "return config.used();"));
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-fallback */
test("methods retain shared captures outside the receiver, through aliases and helpers on TS5/6", () => {
  for (const compiler of compilers) {
    for (const code of [
      "const values = [1]; export const config = { used() { return values[0]; }, update() { values.splice(0, 1, 2); } };",
      "const state = { value: 1 }; export const config = { used() { return state.value; }, update() { state.value = 2; } };",
      "const values = [1]; const alias = values; export const config = { used() { return alias[0]; }, update() { alias.splice(0, 1, 2); } };",
      "const values = [1]; function read() { return values[0]; } function write(value: number) { values[0] = value; } export const config = { used() { return read(); }, update() { write(2); } };",
      "const values = [1]; const read = () => values[0]; const write = (n: number) => { values[0] = n; }; export const config = { used() { return read(); }, update() { write(2); } };",
      "const values = [1]; function a() { return b(); } function b() { return values[0] || a(); } export const config = { used() { return a(); }, update() { values.splice(0, 1, 2); } };",
      "function helper(n: number) { if (n) helper.value = n; return helper.value; } export const config = { used() { return helper(0); }, update() { helper(2); } };",
      "export const config = { used: function f(n: number) { if (n) f.value = n; return f.value; }, update() { config.used(2); } };",
    ]) {
      const changed = code.replace(/\b2\b/, "3");
      assert.notEqual(fingerprint(compiler, code, "return config.used();"), fingerprint(compiler, changed, "return config.used();"), `${compiler.version}: ${code}`);
    }
    const imported = "import { read, write } from 'state'; export const config = { used() { return read(); }, update() { write(2); } };";
    const state = { "state.ts": "const values = [1]; export function read() { return values[0]; } export function write(n: number) { values[0] = n; }" };
    assert.notEqual(fingerprint(compiler, imported, "return config.used();", state), fingerprint(compiler, imported.replace("write(2)", "write(3)"), "return config.used();", state));
    const functionState = "function write(fn, n) { fn.value = n; } export const config = { used() { return 0; }, update() { write(config.used, 2); } };";
    for (const access of ["config.used.value", "(config.used)['value']"]) {
      assert.notEqual(fingerprint(compiler, functionState, `return ${access};`), fingerprint(compiler, functionState.replace("used, 2", "used, 3"), `return ${access};`));
    }
  }
});

/** @tests Cli
 * @covers review-dependency-isolated review-dependency-relevant */
test("pure helpers, immutable captures and per-call local state keep independent methods isolated", () => {
  for (const compiler of compilers) {
    const code = "const offset = 1; function helper(n: number) { const values = [n]; return values[0] + offset; } export const config = { used(n: number) { return helper(n); }, spare() { return 20; } };";
    const before = fingerprint(compiler, code, "return config.used(2);");
    assert.equal(before, fingerprint(compiler, code.replace("return 20", "return 30"), "return config.used(2);"));
    assert.notEqual(before, fingerprint(compiler, code.replace("offset = 1", "offset = 2"), "return config.used(2);"));
    assert.notEqual(before, fingerprint(compiler, code.replace("+ offset", "- offset"), "return config.used(2);"));
    const imported = "import { helper } from 'helper'; export const config = { used(n: number) { return helper(n); }, spare() { return 20; } };";
    const extra = { "helper.ts": "export function helper(n: number) { return n + 1; }" };
    assert.equal(fingerprint(compiler, imported, "return config.used(2);", extra), fingerprint(compiler, imported.replace("return 20", "return 30"), "return config.used(2);", extra));
  }
});

/** @tests Cli
 * @covers review-dependency-isolated review-dependency-relevant */
test("method parameters and local bindings do not select independent sibling methods on TS5/6", () => {
  for (const compiler of compilers) {
    for (const method of [
      "used(n: number) { return n + 1; }",
      "used() { const n = 2; return n + 1; }",
      "used(config: number) { return config + 1; }",
      "used() { const config = 2; return config + 1; }",
      "used({ n }: { n: number }) { return n + 1; }",
      "used({ n: value }: { n: number }) { return value + 1; }",
      "used(n: number) { const next = () => n + 1; return next(); }",
    ]) {
      const code = `export const config = { ${method}, spare() { return 20; } };`;
      const before = fingerprint(compiler, code, "return config.used(2);");
      assert.equal(before, fingerprint(compiler, code.replace("return 20", "return 30"), "return config.used(2);"), `${compiler.version}: ${method}`);
      assert.notEqual(before, fingerprint(compiler, code.replace("+ 1", "+ 2"), "return config.used(2);"), `${compiler.version}: ${method}`);
    }
  }
});

/** @tests Cli
 * @covers review-dependency-fallback */
test("reflection, escapes, writes, dynamic reads and receiver-dependent methods retain the object", () => {
  for (const compiler of compilers) {
    const code = "export const config = { used: 10, spare: 20 };";
    for (const body of ["return config[key];", "return Object.keys(config);", "return pass(config);", "config.used = 1; return config.used;", "delete config.used; return config.used;", "const alias = config; return alias.used;", "return { ...config };", "const { used } = config; return used;", "({ x: config.used } = source); return config.used;", "[config.used] = source; return config.used;", "for (config.used of values) {} return config.used;", "config.used++; return config.used;"]) {
      assert.notEqual(fingerprint(compiler, code, body), fingerprint(compiler, code.replace("spare: 20", "spare: 30"), body), body);
    }
    const receiver = "export const config = { used() { return this.spare; }, spare: 20 };";
    assert.notEqual(fingerprint(compiler, receiver, "return config.used();"), fingerprint(compiler, receiver.replace("spare: 20", "spare: 30"), "return config.used();"));
    const mutation = code + " export function change() { config.used = config.spare; }";
    assert.notEqual(fingerprint(compiler, mutation), fingerprint(compiler, mutation.replace("spare: 20", "spare: 30")));
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("named re-export aliases preserve the selected field", () => {
  for (const compiler of compilers) {
    const bridge = "export { limits as config } from 'leaf';";
    const leaf = "export const limits = { used: 10, spare: 20 };";
    const before = fingerprint(compiler, bridge, undefined, { "leaf.ts": leaf });
    assert.equal(before, fingerprint(compiler, bridge, undefined, { "leaf.ts": leaf.replace("spare: 20", "spare: 30") }));
    assert.notEqual(before, fingerprint(compiler, bridge, undefined, { "leaf.ts": leaf.replace("used: 10", "used: 11") }));
  }
});

/** @tests Cli
 * @covers review-dependency-fallback review-dependency-relevant */
test("ambiguous receivers, initialization and missing properties keep a conservative fingerprint", () => {
  for (const compiler of compilers) {
    for (const code of [
      "function read() { return this.spare; } export const config = { used: (read as any), spare: 20 };",
      "const shared = { value: 1 }; export const config = { used: shared, spare: shared, extra: 20 };",
      "export const config = { get used() { return this.spare; }, spare: 20 };",
      "export const config = { used: 1, ...other, spare: 20 };",
      "export const config = { used: 1, ['spare']: 20 };",
      "export const config = { used: 1, spare: sideEffect(20) };",
      "export const config = { used: 1, spare: 20, used: 2 };",
      "export class config { static used() { return 1; } static spare() { return 20; } }",
    ]) assert.notEqual(fingerprint(compiler, code), fingerprint(compiler, code.replace("20", "30")), code);
    const missing = "export const config = { spare: 20 };";
    assert.notEqual(fingerprint(compiler, missing), fingerprint(compiler, missing.replace("spare:", "used: 10, spare:")));
    const recursive = "export const config = { used() { return config.other(); }, other() { return config.used(); }, spare: 20 };";
    assert.equal(fingerprint(compiler, recursive), fingerprint(compiler, recursive.replace("20", "30")));
    const plain = "export const config = { used: 10, spare: 20 };";
    assert.notEqual(fingerprint(compiler, plain), fingerprint(compiler, "// @ts-nocheck\n" + plain));
    assert.notEqual(fingerprint(compiler, plain), fingerprint(compiler, plain.replace("used: 10", "/* node:coverage ignore next */ used: 10")));
    for (const declaration of ["export const config: Shape = { used: 10, spare: 20 };", "export const config = { used: 10, spare: 20 } satisfies Shape;"]) {
      const typed = "type Shape = { used: number; spare: number }; " + declaration;
      assert.notEqual(fingerprint(compiler, typed), fingerprint(compiler, typed.replace("spare: number", "spare: number | null")));
    }
  }
});
