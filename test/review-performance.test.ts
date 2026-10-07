import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { dependencySlices, sliceNodes } from "../src/review-slice.ts";

/** Count public Compiler API operations so regressions fail without relying on machine speed. */
function countingCompiler(compiler: typeof ts, symbolLimit = 10000) {
  const counts = { symbols: 0, walks: 0, arrays: 0, resolutions: 0 };
  const wrapped = new Proxy(compiler, {
    get(target, key, receiver) {
      if (key === "createProgram") return (options: ts.CreateProgramOptions) => {
        const program = compiler.createProgram(options);
        const checker = new Proxy(program.getTypeChecker(), {
          get(target, key, receiver) {
            if (key === "getSymbolAtLocation") return (node: ts.Node) => {
              counts.symbols++;
              assert.ok(counts.symbols <= symbolLimit, "dependency analysis exceeded its deterministic symbol-operation budget");
              return target.getSymbolAtLocation(node);
            };
            return Reflect.get(target, key, receiver);
          },
        });
        return new Proxy(program, {
          get(target, key, receiver) {
            return key === "getTypeChecker" ? () => checker : Reflect.get(target, key, receiver);
          },
        });
      };
      if (key === "forEachChild") return (node: ts.Node, callback: (node: ts.Node) => unknown, callbacks?: (nodes: ts.NodeArray<ts.Node>) => unknown) => {
        counts.walks++;
        return compiler.forEachChild(node, callback, callbacks);
      };
      if (key === "isArrayLiteralExpression") return (node: ts.Node) => {
        counts.arrays++;
        // Symbol caching can conceal repeated proofs of the same initializer. Count an
        // expression predicate as well, so disabling proof memoization fails before a hang.
        assert.ok(counts.arrays <= symbolLimit, "dependency analysis exceeded its deterministic expression-operation budget");
        return compiler.isArrayLiteralExpression(node);
      };
      return Reflect.get(target, key, receiver);
    },
  });
  return { compiler: wrapped, counts };
}

function slice(compiler: typeof ts, dependencies: Record<string, string>, rootText = 'import { used } from "dep"; export const run = () => used;', rootCount = 1, symbolLimit = 10000, selectRoots?: (source: ts.SourceFile) => ts.Node[][], resolve?: (specifier: string, file: string) => string | undefined) {
  const measured = countingCompiler(compiler, symbolLimit);
  const sources = new Map(Object.entries({ "root.ts": rootText, ...dependencies }).map(([file, text]) => [file, compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true)]));
  const root = sources.get("root.ts")!;
  const roots = selectRoots ? selectRoots(root).map((nodes) => ({ file: "root.ts", nodes })) : Array.from({ length: rootCount }, () => ({ file: "root.ts", nodes: [root.statements.at(-1)!] }));
  const result = dependencySlices(measured.compiler, sources, roots, Object.keys(dependencies), new Set(), (specifier, file) => {
    measured.counts.resolutions++;
    return resolve ? resolve(specifier, file) : sources.has(`${specifier}.ts`) ? `${specifier}.ts` : undefined;
  });
  return { ...result, counts: measured.counts };
}

const compilers = [ts, ts5 as unknown as typeof ts];

/** @tests Cli
 * @covers review-code-trivia review-packet */
test("many selected declarations share file directive discovery and cached fingerprints", (t) => {
  for (const compiler of compilers) {
    const measure = (size: number) => {
      let visits = 0;
      let walks = 0;
      const measured = new Proxy(compiler, {
        get(target, key, receiver) {
          if (key === "isToken") return (node: ts.Node) => { visits++; return compiler.isToken(node); };
          if (key === "isJSDoc") return (node: ts.Node) => { walks++; return compiler.isJSDoc(node); };
          return Reflect.get(target, key, receiver);
        },
      });
      const source = compiler.createSourceFile("many.ts", [
        "// @ts-nocheck", "const unused = 1;",
        ...Array.from({ length: size }, (_, index) => `/** @implements Port${index} */\nexport class Impl${index} { run() { return ${index}; } }`),
      ].join("\n"), compiler.ScriptTarget.Latest, true);
      const nodes = source.statements.slice(1);
      const start = performance.now();
      const results = nodes.map((node) => sliceNodes(measured, [node]));
      const elapsed = performance.now() - start;
      // Comment discovery must walk the file once, even for many distinct roots.
      assert.ok(visits <= size * 40 + 20, `repeated file walks: ${visits} for ${size} declarations`);
      const firstVisits = visits;
      const firstWalks = walks;
      for (const [index, node] of nodes.entries()) {
        assert.ok(results[index].pieces.some((piece) => piece.startLine === 1 && piece.endLine === 1));
        assert.deepEqual(sliceNodes(measured, [node]), results[index]);
      }
      assert.equal(visits, firstVisits, "cached slices must not rediscover comments");
      assert.equal(walks, firstWalks, "cached fingerprints must not walk syntax again");
      return { elapsed, visits };
    };
    measure(20); // Warm the compiler before reporting timings; correctness uses operation budgets.
    for (const size of [100, 500, 1000]) {
      const samples = Array.from({ length: 3 }, () => measure(size));
      const median = samples.map(({ elapsed }) => elapsed).sort((a, b) => a - b)[1];
      t.diagnostic(`TypeScript ${compiler.version}: ${size} declarations, median ${median.toFixed(1)} ms, ${samples[0].visits} comment-discovery visits (3 fresh snapshots)`);
    }
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated review-dependency-fallback */
test("shared constant initializer graphs have linear proof work and retain the same selected declarations", () => {
  for (const compiler of compilers) {
    const depth = 32;
    const declarations = ["const value0 = 1;"];
    for (let index = 1; index <= depth; index++) declarations.push(`const value${index} = [value${index - 1}, value${index - 1}];`);
    declarations.push(`export const used = value${depth};`);
    const result = slice(compiler, { "dep.ts": [...declarations, "export const unrelated = 123;"].join("\n") }, undefined, 1, depth * 20);
    assert.ok(result.counts.symbols <= depth * 20);
    assert.ok(result.counts.arrays <= depth * 20);
    assert.equal(result.dependencies.get("dep.ts")!.text, declarations.join("\n\n"));
    const imported = slice(compiler, {
      "dep.ts": 'import { used as source } from "leaf"; export const used = [source, source];',
      "leaf.ts": declarations.join("\n"),
    }, undefined, 1, depth * 25);
    assert.ok(imported.counts.symbols <= depth * 25);
    assert.ok(imported.counts.arrays <= depth * 25);
    assert.equal(imported.dependencies.get("leaf.ts")!.text, declarations.join("\n\n"));
    const constantCycle = slice(compiler, { "dep.ts": "const first = second; const second = first; export const used = first;" });
    assert.equal(constantCycle.dependencies.get("dep.ts"), undefined);
    const importCycle = slice(compiler, {
      "dep.ts": 'import { other } from "leaf"; export const used = other;',
      "leaf.ts": 'import { used } from "dep"; export const other = used;',
    });
    assert.equal(importCycle.dependencies.get("dep.ts"), undefined);
    assert.equal(importCycle.dependencies.get("leaf.ts"), undefined);
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("multiple roots share one module setup scan while preserving each root's material", () => {
  for (const compiler of compilers) {
    const rootText = ['import { configure } from "dep";', ...Array.from({ length: 200 }, (_, index) => `configure(${index});`), "export const run = () => 1;"].join("\n");
    const dependencies = { "dep.ts": "export function configure(n: number) { return n; }\nexport const unrelated = 123;" };
    const single = slice(compiler, dependencies, rootText);
    const many = slice(compiler, dependencies, rootText, 40);
    assert.ok(many.counts.walks <= single.counts.walks + 40 * 20, `root count repeated setup AST walks: ${single.counts.walks} -> ${many.counts.walks}`);
    assert.ok(many.counts.symbols <= single.counts.symbols + 40 * 20, `root count repeated setup symbol lookups: ${single.counts.symbols} -> ${many.counts.symbols}`);
    assert.deepEqual(many.dependencies, single.dependencies);
    assert.deepEqual(many.roots, Array.from({ length: 40 }, () => single.roots[0]));
    assert.equal(single.dependencies.get("dep.ts")!.text, "export function configure(n: number) { return n; }");
    assert.equal(single.roots[0].text, 'export const run = () => 1;\n\nimport { configure } from "dep";');
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("distinct test roots reuse shared setup and references without leaking private imports or changing root order", () => {
  for (const compiler of compilers) {
    const dependencies = {
      "setup.ts": "export function configure(n: number) { return n; }",
      "a.ts": "export const valueA = 1;",
      "b.ts": "export const valueB = 2;",
      "shared.ts": "export function shared() { return 3; }",
    };
    const rootText = [
      'import { configure } from "setup";', 'import { valueA } from "a";', 'import { valueB } from "b";',
      'import { shared } from "shared";', 'import { test } from "node:test";', 'import * as v from "vitest";',
      "const helper = () => shared();",
      ...Array.from({ length: 200 }, (_, index) => `configure(${index});`),
      ...Array.from({ length: 40 }, (_, index) => `${index % 2 ? "v.it" : "test"}("root ${index}", () => helper() + ${index % 2 ? "valueB" : "valueA"});`),
    ].join("\n");
    const groups = (source: ts.SourceFile): ts.Node[][] => {
      const helper = source.statements.find((statement) => ts.isVariableStatement(statement))!;
      return source.statements.filter((statement): statement is ts.ExpressionStatement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.getText(source) !== "configure").map((statement) => [statement, helper]);
    };
    const first = slice(compiler, dependencies, rootText, 1, 10000, (source) => groups(source).slice(0, 1));
    const second = slice(compiler, dependencies, rootText, 1, 10000, (source) => groups(source).slice(1, 2));
    const many = slice(compiler, dependencies, rootText, 1, 10000, groups);
    const reversed = slice(compiler, dependencies, rootText, 1, 10000, (source) => groups(source).reverse());
    assert.equal(many.roots[0].text, first.roots[0].text);
    assert.equal(many.roots[1].text, second.roots[0].text);
    assert.match(many.roots[0].text, /import \{ valueA \}/);
    assert.doesNotMatch(many.roots[0].text, /import \{ valueB \}/);
    assert.match(many.roots[1].text, /import \{ valueB \}/);
    assert.doesNotMatch(many.roots[1].text, /import \{ valueA \}/);
    for (const root of many.roots) assert.match(root.text, /import \{ shared \}/);
    assert.deepEqual(reversed.roots.toReversed(), many.roots);
    assert.deepEqual(reversed.dependencies, many.dependencies);
    assert.ok(many.counts.walks <= first.counts.walks + 40 * 40, `distinct roots repeated setup/helper walks: ${first.counts.walks} -> ${many.counts.walks}`);
    assert.ok(many.counts.symbols <= first.counts.symbols + 40 * 40, `distinct roots repeated symbol lookups: ${first.counts.symbols} -> ${many.counts.symbols}`);
    // There are six connecting import statements, including two unresolved runner packages.
    assert.ok(many.counts.resolutions <= 6, `shared imports repeatedly resolved: ${many.counts.resolutions}`);
  }
});

/** @tests Cli
 * @covers review-dependency-relevant review-dependency-isolated */
test("import-resolution caching keeps the declaring file in its identity", () => {
  for (const compiler of compilers) {
    const dependencies = {
      "local.ts": "export const first = 1; export const unrelated = 123;",
      "nested/bridge.ts": 'import { second } from "./local"; export const used = () => second;',
      "nested/local.ts": "export const second = 2; export const unrelated = 456;",
    };
    const rootText = 'import { first } from "./local"; import { used } from "./nested/bridge"; export const run = () => first + used();';
    const result = slice(compiler, dependencies, rootText, 1, 10000, undefined, (specifier, file) => `${file.startsWith("nested/") ? "nested/" : ""}${specifier.slice(2)}.ts`);
    assert.equal(result.dependencies.get("local.ts")!.text, "export const first = 1;");
    assert.equal(result.dependencies.get("nested/local.ts")!.text, "export const second = 2;");
    assert.ok(result.counts.resolutions <= 3, `each declaration should resolve once: ${result.counts.resolutions}`);
  }
});
