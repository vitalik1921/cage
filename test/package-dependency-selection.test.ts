import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { checkDesigns, contract, designProject, mdx } from "./helpers.ts";

const COMPILERS = ["typescript-5", "typescript"] as const;
const lines = (...parts: string[]) => `${parts.join("\n")}\n`;

function project(t: Parameters<typeof designProject>[0], compiler: (typeof COMPILERS)[number], files: Record<string, string>, imported = "Selected"): string {
  const root = designProject(t, { reader: mdx(lines(
    `import type { ${imported} } from "api";`,
    contract("Reader", `value: ${imported};`, "@invariant reads Preserves the value."),
  )) }, {
    "node_modules/api/package.json": JSON.stringify({ name: "api", version: "1.0.0", types: "index.d.ts" }),
    "node_modules/api/index.d.ts": lines('export type { Selected } from "./selected.js";'),
    ...files,
  });
  fs.symlinkSync(path.resolve(import.meta.dirname, "../node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  return root;
}

/** @tests Cli
 * @covers package-types */
test("selected declarations are checked while an unrelated broken declaration does not block an import", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      "node_modules/api/selected.d.ts": lines("export interface Selected { id: string }", "export type Unrelated = MissingName;"),
    });
    assert.deepEqual(checkDesigns(root).errors, [], compiler);
    fs.writeFileSync(path.join(root, "node_modules/api/selected.d.ts"), lines("export interface Selected { id: MissingName }", "export type Unrelated = MissingName;"));
    assert.ok(checkDesigns(root).errors.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT"), compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("computed keys, globalThis contributors and merged module augmentations enter selected package material", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      "node_modules/api/index.d.ts": lines('/// <reference types="globals" />', 'import "augment";', 'export type { Selected } from "./selected.js";'),
      "node_modules/api/selected.d.ts": lines('import type { key } from "keys";', "export interface Selected { [key]: number; env: typeof globalThis.env }"),
      "node_modules/keys/package.json": JSON.stringify({ name: "keys", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/keys/index.d.ts": "export declare const key: unique symbol;\n",
      "node_modules/globals/package.json": JSON.stringify({ name: "globals", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/globals/index.d.ts": "declare var env: { value: string };\n",
      "node_modules/augment/package.json": JSON.stringify({ name: "augment", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/augment/index.d.ts": lines('import "api";', 'declare module "api" { interface Selected { extra: string } }'),
    });
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], `${compiler}: ${result.errors.map((error) => error.message).join("; ")}`);
    const ids = result.index.packages[0].files.map((file) => file.id);
    for (const name of ["keys", "globals", "augment"]) assert.ok(ids.some((id) => id.startsWith(`${name}@`)), `${compiler}: ${name} missing from ${ids}`);
  }
});

/** @tests Cli
 * @covers package-types */
test("missing selected reference directives are reported by the compiler", (t) => {
  for (const compiler of COMPILERS) {
    for (const directive of ['/// <reference path="./missing.d.ts" />', '/// <reference types="missing-types" />']) {
      const root = project(t, compiler, {
        "node_modules/api/selected.d.ts": lines(directive, "export interface Selected { id: string }"),
      });
      const errors = checkDesigns(root).errors;
      assert.ok(errors.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT"), `${compiler}: ${directive}: ${errors.map((error) => error.message)}`);
    }
  }
});

/** @tests Cli
 * @covers package-types */
test("a runtime module backed by ambient declarations follows the compiler-bound types", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      "node_modules/api/index.d.ts": lines('/// <reference types="ambient" />', 'export type { Selected } from "./selected.js";'),
      "node_modules/api/selected.d.ts": lines('import type { EventEmitter } from "events";', "export interface Selected { emitter: EventEmitter }"),
      "node_modules/events/package.json": JSON.stringify({ name: "events", version: "3.3.0", main: "events.js" }),
      "node_modules/events/events.js": "exports.EventEmitter = class EventEmitter {};\n",
      "node_modules/ambient/package.json": JSON.stringify({ name: "ambient", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/ambient/index.d.ts": 'declare module "events" { export interface EventEmitter { on(name: string): void } }\n',
    });
    const result = checkDesigns(root);
    assert.deepEqual(result.errors, [], `${compiler}: ${result.errors.map((error) => error.message)}`);
    const ids = result.index.packages[0].files.map((file) => file.id);
    assert.ok(ids.includes("ambient@1.0.0/index.d.ts"), `${compiler}: ${ids}`);
    assert.ok(ids.every((id) => !id.startsWith("events@")), `${compiler}: ${ids}`);
  }
});

/** @tests Cli
 * @covers package-types */
test("typeof module imports select value exports, excluding unrelated broken type exports", (t) => {
  for (const compiler of COMPILERS) {
    for (const query of ['export type Value = typeof import("dep");', 'import type * as dep from "dep";\nexport type Value = typeof dep;']) {
      const root = project(t, compiler, {
        "node_modules/api/index.d.ts": `${query}\n`,
        "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", types: "index.d.ts" }),
        "node_modules/dep/index.d.ts": lines('export declare const value: { id: string };', 'export type Unrelated = { id: string }["missing"];'),
        "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true } }),
      }, "Value");
      const dep = path.join(root, "node_modules/dep/index.d.ts");
      assert.deepEqual(checkDesigns(root).errors, [], `${compiler}: unrelated type export: ${query}`);
      fs.writeFileSync(dep, lines('export declare const value: { id: string }["missing"];', 'export type Unrelated = { id: string }["missing"];'));
      const invalid = checkDesigns(root).errors;
      assert.ok(invalid.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT" && diagnostic.message.includes("TS2339")), `${compiler}: selected value: ${query}: ${invalid.map((error) => error.message)}`);
      fs.writeFileSync(dep, lines('// @ts-ignore', 'export declare const value: { id: string }["missing"];', 'export type Unrelated = { id: string }["missing"];'));
      assert.deepEqual(checkDesigns(root).errors, [], `${compiler}: suppressed value: ${query}`);
    }
  }
});

/** @tests Cli
 * @covers package-types */
test("typeof module imports follow export-equals callable declarations", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      "node_modules/api/index.d.ts": 'export type Value = typeof import("dep");\n',
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", types: "index.d.ts" }),
      "node_modules/dep/index.d.ts": lines('declare function value(): { id: string }["missing"];', "export = value;"),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true } }),
    }, "Value");
    const invalid = checkDesigns(root).errors;
    assert.ok(invalid.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT" && diagnostic.message.includes("TS2339")), `${compiler}: ${invalid.map((error) => error.message)}`);
    fs.writeFileSync(path.join(root, "node_modules/dep/index.d.ts"), lines("// @ts-ignore", 'declare function value(): { id: string }["missing"];', "export = value;"));
    assert.deepEqual(checkDesigns(root).errors, [], compiler);
  }
});

/** @tests Cli
 * @covers package-types */
test("typeof module imports respect type-only class re-exports through direct and star routes", (t) => {
  for (const compiler of COMPILERS) {
    for (const query of ['export type Value = typeof import("dep");', 'import type * as dep from "dep";\nexport type Value = typeof dep;']) {
      const root = project(t, compiler, {
        "node_modules/api/index.d.ts": `${query}\n`,
        "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", types: "index.d.ts" }),
        "node_modules/dep/index.d.ts": lines('declare class Hidden { value: { id: string }["missing"] }', 'export type { Hidden };', 'export declare const value: string;'),
        "node_modules/dep/hidden.d.ts": 'export declare class Hidden { value: { id: string }["missing"] }\n',
        "node_modules/dep/bridge.d.ts": 'export * from "./hidden.js";\n',
        "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true } }),
      }, "Value");
      const index = path.join(root, "node_modules/dep/index.d.ts");
      const cases = [
        [lines('declare class Hidden { value: { id: string }["missing"] }', 'export type { Hidden };', 'export declare const value: string;'), false],
        [lines('declare class Hidden { value: { id: string }["missing"] }', 'export { Hidden };', 'export declare const value: string;'), true],
        [lines('export type * from "./hidden.js";', 'export declare const value: string;'), false],
        [lines('export * from "./hidden.js";', 'export declare const value: string;'), true],
        [lines('export type * from "./bridge.js";', 'export declare const value: string;'), false],
        [lines('export * from "./bridge.js";', 'export declare const value: string;'), true],
      ] as const;
      for (const [source, selected] of cases) {
        fs.writeFileSync(index, source);
        const errors = checkDesigns(root).errors;
        assert.equal(errors.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT"), selected, `${compiler}: ${query}: ${source}: ${errors.map((error) => error.message)}`);
      }
    }
  }
});

/** @tests Cli
 * @covers package-types */
test("typeof module imports check exported import-equals aliases and destructured values", (t) => {
  for (const compiler of COMPILERS) {
    for (const query of ['export type Value = typeof import("dep");', 'import type * as dep from "dep";\nexport type Value = typeof dep;']) {
      const root = project(t, compiler, {
        "node_modules/api/index.d.ts": `${query}\n`,
        "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", types: "index.d.ts" }),
        "node_modules/dep/index.d.ts": 'export declare const value: string;\n',
        "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true } }),
      }, "Value");
      const index = path.join(root, "node_modules/dep/index.d.ts");
      const invalid = [
        lines('declare namespace Inner { class Broken { value: { id: string }["missing"] } }', 'export import Alias = Inner.Broken;'),
        'export declare const { selected }: { selected: { id: string }["missing"] };\n',
        'export declare const { inner: { selected } }: { inner: { selected: { id: string }["missing"] } };\n',
        'export namespace Outer.Inner { export class Broken { value: { id: string }["missing"] } }\n',
      ];
      for (const source of invalid) {
        fs.writeFileSync(index, source);
        const errors = checkDesigns(root).errors;
        assert.ok(errors.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT" && diagnostic.message.includes("TS2339")), `${compiler}: ${query}: ${source}: ${errors.map((error) => error.message)}`);
      }
    }
  }
});

/** @tests Cli
 * @covers package-types */
test("type-only ambient star exports stay out of a module value even when both modules share a file", (t) => {
  for (const compiler of COMPILERS) {
    const root = project(t, compiler, {
      "node_modules/api/index.d.ts": 'export type Value = typeof import("dep");\n',
      "node_modules/dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", types: "ambient.d.ts" }),
      "node_modules/dep/ambient.d.ts": lines(
        'declare module "inner" { export class Broken { value: { id: string }["missing"] } }',
        'declare module "dep" { export type * from "inner"; export const value: string; }',
      ),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true } }),
    }, "Value");
    assert.deepEqual(checkDesigns(root).errors, [], compiler);
    fs.writeFileSync(path.join(root, "node_modules/dep/ambient.d.ts"), lines(
      'declare module "inner" { export class Broken { value: { id: string }["missing"] } }',
      'declare module "dep" { export * from "inner"; export const value: string; }',
    ));
    const errors = checkDesigns(root).errors;
    assert.ok(errors.some((diagnostic) => diagnostic.code === "E_DESIGN_IMPORT" && diagnostic.message.includes("TS2339")), `${compiler}: ${errors.map((error) => error.message)}`);
  }
});
