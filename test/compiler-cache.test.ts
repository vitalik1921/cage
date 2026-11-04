import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import ts5 from "typescript-5";
import { createOverlay, createOverlayProgram } from "../src/typescript.ts";
import { createPackageTypesResolver } from "../src/package-types.ts";
import { designProject, writeFile } from "./helpers.ts";

/** @tests Cli
 * @covers package-types exact-signatures draft-candidate */
test("overlay resolution reuses lookups while keeping importer directories and import/require modes distinct on TS5/6", t => {
  for (const compiler of [ts, ts5 as unknown as typeof ts]) {
    const root = designProject(t, {}, {
      "node_modules/dual/package.json": JSON.stringify({ name: "dual", version: "1.0.0", exports: { ".": { import: "./import.d.mts", require: "./require.d.cts" } } }),
      "node_modules/dual/import.d.mts": 'export type Kind = "import";',
      "node_modules/dual/require.d.cts": 'export type Kind = "require";',
      "node_modules/@types/ambient/index.d.ts": "declare const ambient: string;",
      "node_modules/@types/ambient/package.json": JSON.stringify({ name: "@types/ambient", version: "1.0.0", types: "index.d.ts" }),
      "src/a/dep.ts": 'export const value = "a";',
      "src/b/dep.ts": 'export const value = "b";',
    });
    let reads = 0;
    const measured = new Proxy(compiler, { get(target, key, receiver) {
      if (key === "createCompilerHost") return (...args: Parameters<typeof ts.createCompilerHost>) => {
        const host = compiler.createCompilerHost(...args);
        return { ...host,
          fileExists: (file: string) => { reads++; return host.fileExists(file); },
          readFile: (file: string) => { reads++; return host.readFile(file); },
        };
      };
      return Reflect.get(target, key, receiver);
    } });
    const options = { module: compiler.ModuleKind.NodeNext, moduleResolution: compiler.ModuleResolutionKind.NodeNext, types: [], typeRoots: [path.join(root, "node_modules/@types")] };
    const overlay = createOverlay(measured, options, new Map());
    const from = path.join(root, "src/a/entry.mts");
    const other = path.join(root, "src/b/entry.mts");
    const esm = compiler.ModuleKind.ESNext, cjs = compiler.ModuleKind.CommonJS;
    const read = () => [
      overlay.resolveModuleFull("dual", from, esm)?.resolvedFileName,
      overlay.resolveModuleFull("dual", from, cjs)?.resolvedFileName,
      overlay.resolveModuleFull("./dep.js", from, esm)?.resolvedFileName,
      overlay.resolveModuleFull("./dep.js", other, esm)?.resolvedFileName,
      overlay.resolveModuleFull("missing", from, esm),
      overlay.resolveTypeReference("ambient", from, esm)?.resolvedFileName,
      overlay.resolveTypeReference("missing", from, esm),
    ];
    const expected = ["node_modules/dual/import.d.mts", "node_modules/dual/require.d.cts", "src/a/dep.ts", "src/b/dep.ts"].map(file => path.join(root, file));
    const first = read();
    assert.deepEqual(first, [...expected, undefined, path.join(root, "node_modules/@types/ambient/index.d.ts"), undefined]);
    const warmReads = reads;
    for (let i = 0; i < 100; i++) assert.deepEqual(read(), first);
    assert.equal(reads, warmReads, "repeated resolution must not repeat filesystem probes");
  }
});

/** @tests Cli
 * @covers package-types draft-candidate draft-activate */
test("adding virtual files invalidates successful and failed resolutions; fresh overlays observe disk edits on TS5/6", t => {
  for (const compiler of [ts, ts5 as unknown as typeof ts]) {
    const root = designProject(t, {}, { "src/shadow.js": "export const value = 1;" });
    const options = { module: compiler.ModuleKind.NodeNext, moduleResolution: compiler.ModuleResolutionKind.NodeNext, types: [], typeRoots: [path.join(root, "node_modules/@types")] };
    const overlay = createOverlay(compiler, options, new Map());
    const from = path.join(root, "src/entry.mts"), mode = compiler.ModuleKind.ESNext;
    assert.equal(overlay.resolveModuleFull("./future.js", from, mode), undefined);
    assert.equal(overlay.resolveModuleFull("./shadow.js", from, mode)?.resolvedFileName, path.join(root, "src/shadow.js"));
    assert.equal(overlay.resolveTypeReference("future", from, mode), undefined);
    overlay.add(new Map([
      [path.join(root, "src/future.ts"), "export const value = 2;"],
      [path.join(root, "src/shadow.ts"), "export const value = 3;"],
      [path.join(root, "node_modules/@types/future/index.d.ts"), "declare const future: number;"],
      [path.join(root, "node_modules/@types/future/package.json"), JSON.stringify({ name: "@types/future", version: "1.0.0", types: "index.d.ts" })],
    ]));
    assert.equal(overlay.resolveModuleFull("./future.js", from, mode)?.resolvedFileName, path.join(root, "src/future.ts"));
    assert.equal(overlay.resolveModuleFull("./shadow.js", from, mode)?.resolvedFileName, path.join(root, "src/shadow.ts"));
    assert.equal(overlay.resolveTypeReference("future", from, mode)?.resolvedFileName, path.join(root, "node_modules/@types/future/index.d.ts"));
    // The next command cannot inherit either a virtual file or a cached miss.
    writeFile(root, "src/future.js", "export const value = 4;");
    const fresh = createOverlay(compiler, options, new Map());
    assert.equal(fresh.resolveModuleFull("./future.js", from, mode)?.resolvedFileName, path.join(root, "src/future.js"));
    assert.equal(fresh.resolveModuleFull("./shadow.js", from, mode)?.resolvedFileName, path.join(root, "src/shadow.js"));
    assert.equal(fresh.resolveTypeReference("future", from, mode), undefined);
  }
});

/** @tests Cli
 * @covers package-types project-vocabulary review-stale */
test("repeated package selections reuse traversal but keep selected names and fresh compiler programs independent on TS5/6", t => {
  for (const compiler of [ts, ts5 as unknown as typeof ts]) {
    const root = designProject(t, {}, {
      "node_modules/shapes/package.json": JSON.stringify({ name: "shapes", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/shapes/index.d.ts": 'import type { Left } from "./left.js";\nimport type { Right } from "./right.js";\nexport interface First { value: Left }\nexport interface Second { value: Right }',
      "node_modules/shapes/left.d.ts": "export interface Left { left: number }",
      "node_modules/shapes/right.d.ts": "export interface Right { right: boolean }",
      "src/vocabulary.ts": "export interface Allowed { value: number }\nexport interface Private { hidden: boolean }",
    });
    let walks = 0;
    const measured = new Proxy(compiler, { get(target, key, receiver) {
      if (key === "forEachChild") return (...args: Parameters<typeof ts.forEachChild>) => { walks++; return compiler.forEachChild(...args); };
      return Reflect.get(target, key, receiver);
    } });
    const options = { module: compiler.ModuleKind.NodeNext, moduleResolution: compiler.ModuleResolutionKind.NodeNext, types: [], skipLibCheck: true };
    const from = path.join(root, "src/entry.mts"), mode = compiler.ModuleKind.ESNext;
    const make = () => {
      const overlay = createOverlayProgram(measured, options, new Map([[from, 'import type { First, Second } from "shapes";\nimport type { Allowed, Private } from "./vocabulary.js";']]));
      return createPackageTypesResolver(measured, root, overlay, overlay.program, options, ["src/vocabulary.ts#Allowed"]);
    };
    const resolver = make();
    const selected = (names: string[]) => {
      const result = resolver.select("shapes", from, mode, names);
      assert.ok(!("problem" in result), JSON.stringify(result));
      return result.entry.files;
    };
    const first = selected(["First"]);
    assert.ok(first.some(file => file.file.endsWith("/left.d.ts")));
    assert.ok(!first.some(file => file.file.endsWith("/right.d.ts")));
    const afterFirst = walks;
    for (let i = 0; i < 100; i++) assert.deepEqual(selected(["First"]), first);
    assert.equal(walks, afterFirst, "the same selected package API must not be traversed again for every design");
    const second = selected(["Second"]);
    assert.ok(second.some(file => file.file.endsWith("/right.d.ts")));
    assert.ok(!second.some(file => file.file.endsWith("/left.d.ts")));
    assert.ok(walks > afterFirst, "different named exports need their own selection");
    assert.ok(!("problem" in resolver.select("./vocabulary.js", from, mode, ["Allowed"])));
    assert.match(JSON.stringify(resolver.select("./vocabulary.js", from, mode, ["Private"])), /not designated/);
    writeFile(root, "node_modules/shapes/left.d.ts", "export interface Left { left: string }");
    const fresh = make().select("shapes", from, mode, ["First"]);
    assert.ok(!("problem" in fresh));
    assert.notDeepEqual(fresh.entry.files, first, "a new program must see edited declarations and their new digests");
    assert.match(fresh.entry.files.find(file => file.file.endsWith("/left.d.ts"))!.text, /left: string/);
  }
});
