import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { checkLinking, contract, data, designProject, mdx, writeFile } from "./helpers.ts";

const compilers = ["typescript-5", "typescript"] as const;

/** Zod 3's shapes in miniature: output types built from mapped helpers that lose their aliases, defaults derived from them, `this` in results. */
const LIBRARY = [
  "export type identity<T> = T;",
  "export type flatten<T> = identity<{ [k in keyof T]: T[k] }>;",
  "type requiredKeys<T extends object> = { [k in keyof T]: undefined extends T[k] ? never : k }[keyof T];",
  "type optionalKeys<T extends object> = { [k in keyof T]: undefined extends T[k] ? k : never }[keyof T];",
  "export type addQuestionMarks<T extends object> = { [K in requiredKeys<T>]: T[K] } & { [K in optionalKeys<T>]?: T[K] } & { [k in keyof T]?: unknown };",
  "export type extendShape<A, B> = { [K in keyof A | keyof B]: K extends keyof B ? B[K] : K extends keyof A ? A[K] : never };",
  "export type Mode = \"strip\" | \"passthrough\";",
  "export type Passthrough<M extends Mode> = M extends \"passthrough\" ? { [k: string]: unknown } : unknown;",
  "export type RawShape = { [k: string]: Type<unknown> };",
  "export type outputOf<S extends RawShape, M extends Mode> = flatten<addQuestionMarks<{ [k in keyof S]: S[k][\"_output\"] }>> & Passthrough<M>;",
  "export declare class Type<O> { readonly _output: O; parse(value: unknown): O; optional(): Optional<this>; }",
  "export declare class Str extends Type<string> { min(length: number): Str; }",
  "export declare class Num extends Type<number> { int(): Num; }",
  "export declare class Optional<T extends Type<unknown>> extends Type<T[\"_output\"] | undefined> { unwrap(): T; }",
  "export declare class Effects<T extends Type<unknown>, O> extends Type<O> { inner(): T; }",
  "export declare class Obj<S extends RawShape, M extends Mode = Mode, Output = outputOf<S, M>> extends Type<Output> {",
  "  readonly shape: S;",
  "  strict(): Obj<S, \"strip\">;",
  "  extend<A extends RawShape>(augmentation: A): Obj<extendShape<S, A>, M>;",
  "  refine<R extends Output>(check: (arg: Output) => arg is R): Effects<this, R>;",
  "  pick<Mask extends { [k in keyof S]?: true }>(mask: Mask): Obj<S, M>;",
  "}",
  "export declare function object<S extends RawShape>(shape: S): Obj<S, \"strip\", outputOf<S, \"strip\">>;",
  "export declare function string(): Str;",
  "export declare function number(): Num;",
  "",
].join("\n");

function project(t: TestContext, compiler: string, designs: string[], files: Record<string, string>) {
  const root = designProject(t, { m: mdx(...designs) }, files);
  writeFile(root, "node_modules/lib/package.json", JSON.stringify({ name: "lib", version: "1.0.0", types: "./index.d.ts" }));
  writeFile(root, "node_modules/lib/index.d.ts", LIBRARY);
  fs.symlinkSync(path.resolve("node_modules", compiler), path.join(root, "node_modules/typescript"), "dir");
  const result = checkLinking(root);
  assert.equal(result.typescript.version, compiler === "typescript-5" ? "5.9.3" : "6.0.3");
  return result;
}

const schema = (base: string) => [
  'import type { Obj, Str, Num } from "lib";',
  "/**", " * @contract", " * @description Schema.", " */", `export interface Schema extends ${base} {}`,
].join("\n");
const implementation = (value: string) => `import { object, string, number } from "lib";\n/** @implements Schema */\nexport const schema = ${value};\n`;

/** @tests Cli
 * @covers exact-signatures */
test("a library schema matches an interface that only extends its instantiation, with derived mapped defaults, on TS5/TS6", (t) => {
  for (const compiler of compilers) {
    const result = project(t, compiler, [schema('Obj<{ id: Str; size: Num }, "strip">')], { "src/m/schema.ts": implementation("object({ id: string(), size: number() })") });
    assert.deepEqual(result.errors, [], compiler);
    assert.equal(result.linking.implementations[0]?.compatible, true, compiler);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("a library schema with a different shape, key, value, modifier, argument or method is rejected on TS5/TS6", (t) => {
  const cases: Record<string, [string, string]> = {
    key: ['Obj<{ id: Str }, "strip">', "object({ name: string() })"],
    value: ['Obj<{ id: Str }, "strip">', "object({ id: number() })"],
    "extra key": ['Obj<{ id: Str }, "strip">', "object({ id: string(), size: number() })"],
    // Assignable, but the shape and the derived output differ in a modifier.
    readonly: ['Obj<{ readonly id: Str }, "strip">', "object({ id: string() })"],
    optional: ['Obj<{ id?: Str }, "strip">', "object({ id: string() })"],
    "generic argument": ['Obj<{ id: Str }, "passthrough">', "object({ id: string() })"],
    "extra method": ['Obj<{ id: Str }, "strip">', "Object.assign(object({ id: string() }), { extra(): void {} })"],
    "changed method": ['Obj<{ id: Str }, "strip">', "Object.assign(object({ id: string() }), { strict(): Obj<{ id: Str }, \"strip\"> & { loose?: true } { return this; } })"],
  };
  for (const compiler of compilers) for (const [name, [base, value]] of Object.entries(cases)) {
    const result = project(t, compiler, [schema(base)], { "src/m/schema.ts": implementation(value).replace('from "lib";', 'from "lib";\nimport type { Obj, Str } from "lib";') });
    assert.equal(result.linking.implementations[0]?.compatible, false, `${compiler} ${name}`);
    // A definite difference is always reported. Members whose difference is not provable stay at the guard:
    // refine<R extends Output> over unequal owner arguments, or extend's ever-growing result for another mode.
    const definite = result.errors.filter(d => d.code !== "E_CONTRACT_UNCHECKABLE");
    assert.ok(definite.length, `${compiler} ${name}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`);
    // pick's constraint is written over the shape: with another shape it is never proved equal.
    if (!name.includes("method") && !name.includes("argument")) assert.ok(result.errors.some(d => /^schema\.pick:/.test(d.message)) || result.errors.some(d => d.code === "E_TYPE_MISMATCH"), `${compiler} ${name}: pick not reported`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("a library schema whose difference never surfaces in a finite comparison stays at the explicit guard on TS5/TS6", (t) => {
  // Obj<S, Mode> against Obj<S, "strip">: the mode reaches only extend's ever-growing result and Passthrough<M>,
  // which is unknown for both. Equivalent at every depth, unprovable here: unchecked, never approved.
  for (const compiler of compilers) {
    const result = project(t, compiler, [schema("Obj<{ id: Str }>")], { "src/m/schema.ts": implementation("object({ id: string() })") });
    assert.equal(result.linking.implementations[0]?.compatible, false, compiler);
    assert.ok(result.errors.length && result.errors.every(d => d.code === "E_CONTRACT_UNCHECKABLE"), `${compiler}: ${JSON.stringify(result.errors.map(d => d.code + " " + d.message.split("\n")[0]))}`);
  }
});

/** @tests Cli
 * @covers exact-signatures */
test("members of mapped helpers that lose their alias keep the checker's readonly and optional on TS5/TS6", (t) => {
  const designs = [
    data("Id<T>", "T"),
    data("Flat<T>", "Id<{ [k in keyof T]: T[k] }>"),
    data("Mutable<T>", "Id<{ -readonly [k in keyof T]: T[k] }>"),
    data("Picked<T, K extends keyof T>", "Id<{ [P in K]: T[P] }>"),
    contract("Reader", "read(): Flat<{ readonly a: string; b?: number }>;\n  write(): Mutable<{ readonly a: string }>;\n  pick(): Picked<{ readonly a: string; c: number }, \"a\">;"),
  ];
  const source = (read: string, write: string, pick: string) =>
    `/** @implements Reader */\nexport class Reader {\n  read(): ${read} { return { a: "" }; }\n  write(): ${write} { return { a: "" }; }\n  pick(): ${pick} { return { a: "" }; }\n}\n`;
  const exact = ["{ readonly a: string; b?: number }", "{ a: string }", "{ readonly a: string }"] as const;
  const cases: Record<string, [string, string, string]> = {
    exact: [...exact],
    "readonly lost": ["{ a: string; b?: number }", exact[1], exact[2]],
    "optional lost": ["{ readonly a: string; b: number | undefined }", exact[1], exact[2]],
    "readonly kept": [exact[0], "{ readonly a: string }", exact[2]],
    "picked readonly lost": [exact[0], exact[1], "{ a: string }"],
  };
  for (const compiler of compilers) for (const [name, members] of Object.entries(cases)) {
    const result = project(t, compiler, designs, { "src/m/impl.ts": source(...members) });
    assert.ok(!result.errors.some(d => d.code === "E_CONTRACT_UNCHECKABLE"), `${compiler} ${name}: ${JSON.stringify(result.errors)}`);
    assert.equal(result.linking.implementations[0]?.compatible, name === "exact", `${compiler} ${name}: ${JSON.stringify(result.errors.map(d => d.message.split("\n")[0]))}`);
  }
});
